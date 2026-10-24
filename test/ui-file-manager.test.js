import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b, appRoot;
before(async () => {
  appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ui-'));
  node = await makeNode({ appRoot });
  // The shipped site/ folder is not reachable from File Manager, so the disk fixtures live in the plugins folder.
  const loc = path.join(node.ctx.env.PLUGINS_DIR, 'other/locales');
  fs.mkdirSync(loc, { recursive: true });
  fs.writeFileSync(path.join(loc, 'en.json'), '{"hello":"Hello world"}');
  fs.writeFileSync(path.join(loc, 'old.json'), '{}');
  fs.cpSync(
    path.resolve('plugins/file-manager'),
    path.join(node.ctx.env.PLUGINS_DIR, 'file-manager'),
    {
      recursive: true,
    },
  );
  const api = await signedIn(node.app);
  await api.post('/api/admin/plugins/rescan').send({});
  await api.post('/api/admin/plugins/file-manager/enable').send({});
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
  fs.rmSync(appRoot, { recursive: true, force: true });
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const root = () => b.$('[data-testid="file-manager"]');
const state = () => b.win.Alpine.$data(root());
const link = (text) =>
  [...root().querySelectorAll('.fm-list a.fm-name')].find((a) => a.textContent.trim() === text);

test('File Manager screen: browse, open a file, and delete only after typing its name', async () => {
  b.go('#/plugin-file-manager');
  await wait(() => root() && state().roots.length === 2);
  assert.deepEqual(
    state().roots.map((r) => r.id),
    ['public', 'plugins'],
  );

  b.click(
    [...root().querySelectorAll('.fm-seg.roots button')].find((x) => x.textContent === 'plugins'),
  );
  await wait(() => link('other'));
  b.click(link('other'));
  await wait(() => link('locales'));
  b.click(link('locales'));
  await wait(() => link('en.json'));
  b.click(link('en.json'));
  await wait(() => state().file?.path === 'other/locales/en.json');
  assert.equal(state().content, '{"hello":"Hello world"}');

  // Delete: the button stays disabled until the exact name is typed.
  const trash = [...root().querySelectorAll('.fm-list li')]
    .find((tr) => tr.textContent.includes('old.json'))
    .querySelector('button[aria-label="Delete old.json"]');
  b.click(trash);
  await wait(() => state().del?.name === 'old.json');
  const confirmBtn = () =>
    [...root().querySelectorAll('button')].find((x) => x.textContent === 'Delete permanently');
  await wait(() => confirmBtn());
  assert.equal(confirmBtn().disabled, true);
  b.type(root().querySelector('#fm-del-confirm'), 'wrong');
  await wait(() => state().delConfirm === 'wrong');
  assert.equal(confirmBtn().disabled, true);
  b.type(root().querySelector('#fm-del-confirm'), 'old.json');
  await wait(() => confirmBtn().disabled === false);
  b.click(confirmBtn());
  await wait(() => !link('old.json'));
  assert.equal(fs.existsSync(path.join(node.ctx.env.PLUGINS_DIR, 'other/locales/old.json')), false);
  assert.equal(fs.existsSync(path.join(node.ctx.env.PLUGINS_DIR, 'other/locales/en.json')), true);
});

test('File Manager screen: search shows matches and opens the file', async () => {
  const tab = [...root().querySelectorAll('.fm-head [role=tab]')].find(
    (x) => x.textContent.trim() === 'Search',
  );
  b.click(tab);
  b.type(root().querySelector('#fm-q'), 'Hello');
  await wait(() => state().q === 'Hello');
  b.click(
    [...root().querySelectorAll('button')].find(
      (x) => x.textContent === 'Search' && x.type === 'submit',
    ),
  );
  await wait(() => state().results.length > 0);
  const hit = state().results.find((r) => r.path === 'other/locales/en.json');
  assert.ok(hit, 'finds the line in other/locales/en.json');
  b.click(
    [...root().querySelectorAll('.fm-hit a')].find(
      (a) => a.textContent === 'plugins/other/locales/en.json',
    ),
  );
  await wait(() => state().tab === 'files' && state().file?.path === 'other/locales/en.json');
});

// jsdom doesn't enforce the Content-Security-Policy a real browser does (script-src 'self'), which is how an inline
// <script> in this screen once passed every test and then failed for real. Guard the rule directly.
test('File Manager screen ships its script as a file, never inline (the CSP blocks inline scripts)', async () => {
  const html = fs.readFileSync(path.resolve('plugins/file-manager/admin/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attrs] of scripts) assert.match(attrs, /\bsrc="/, 'every <script> has a src');
  const res = await fetch(`${node.url}/admin/modules/plugin-file-manager/app.js`, {
    headers: { cookie: '' },
  });
  assert.ok([200, 401, 404].includes(res.status)); // served behind the session; the file exists on disk
  assert.ok(fs.existsSync(path.resolve('plugins/file-manager/admin/app.js')));
});

test('File Manager screen: the create form is hidden until asked for', async () => {
  b.go('#/plugin-file-manager');
  await wait(() => root() && state().roots.length === 2);
  const form = root().querySelector('form.fm-create');
  assert.equal(form.style.display, 'none', 'create form hidden by default');
  b.click(
    [...root().querySelectorAll('.fm-tools button')].find((x) => x.textContent.includes('File')),
  );
  await wait(() => form.style.display !== 'none');
});

test('File Manager screen: "New folder" works in public, opening the folder for its first file', async () => {
  b.go('#/plugin-file-manager');
  await wait(() => root() && state().roots.length === 2);
  b.click(
    [...root().querySelectorAll('.fm-seg.roots button')].find((x) => x.textContent === 'public'),
  );
  await wait(() => state().root === 'public');
  await state().goDir('components');
  const folderBtn = [...root().querySelectorAll('.fm-tools button')].find((x) =>
    x.textContent.includes('Folder'),
  );
  assert.ok(folderBtn && folderBtn.style.display !== 'none', 'the button is there in public');
  b.click(folderBtn);
  await wait(() => state().creating === 'dir');
  b.type(root().querySelector('#fm-new'), 'cards');
  b.submit(root().querySelector('form.fm-create'));
  await wait(() => state().path === 'components/cards');
  assert.equal(state().creating, 'file', 'now asks for the first file');
  // a name the tree doesn't have at the top is refused with the fix
  await state().goDir('');
  state().startCreate('dir');
  b.type(root().querySelector('#fm-new'), 'stuff');
  b.submit(root().querySelector('form.fm-create'));
  await wait(() => /pages, components and locales/.test(state().error));
});
