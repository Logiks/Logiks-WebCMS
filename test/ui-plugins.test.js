import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
const file = (buf, name, type) => new b.win.File([buf], name, { type });
const chooseFiles = (input, files) => {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};

const zipOf = (files) => {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  return z.toBuffer();
};
const PLUGIN = zipOf({
  'plugin.json': JSON.stringify({
    slug: 'uiplug',
    name: 'UI Plugin',
    version: '1.0.0',
    author: 'Test',
    description: 'A UI test plugin.',
    menu: { label: 'UI Plugin', icon: 'bi-puzzle' },
    permissions: [],
  }),
  'server.js':
    "export default (ctx) => { const { Router } = ctx.require('express'); const r = Router(); r.get('/ping', (req, res) => res.json({ ok: true })); return r; };",
  'admin/index.html': '<div data-testid="uiplug-screen">Hello from the UI plugin</div>',
});

const groupLinks = () =>
  b
    .$$('.nav-sub')
    .filter(b.visible)
    .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map((a) => a.textContent.trim()));

test('Applications group starts with just the Plugin Manager', async () => {
  b.go('#/overview');
  await wait(() => b.button('Applications'));
  b.click(b.button('Applications'));
  await wait(() => groupLinks().length);
  assert.deepEqual(groupLinks(), ['Plugin Manager']);
});

test('installing and enabling a plugin from the admin adds its own nav item and screen; disabling removes it', async () => {
  b.go('#/plugins');
  await wait(() => sec('pluginsPage'));
  chooseFiles(sec('pluginsPage').querySelector('input[type="file"]'), [
    file(PLUGIN, 'uiplug.zip', 'application/zip'),
  ]);
  await wait(() => /UI Plugin/.test(sec('pluginsPage').textContent));

  const row = () =>
    [...sec('pluginsPage').querySelectorAll('tr')].find((r) => /UI Plugin/.test(r.textContent));
  const enableBtn = () =>
    [...row().querySelectorAll('button')].find((x) => x.textContent === 'Enable');
  await wait(() => enableBtn());
  b.click(enableBtn());
  await wait(() => /Disable/.test(row().textContent));

  // #/plugins is itself inside Applications, so syncRoute() already keeps the group open here (D-059's
  // auto-open-on-navigate behaviour) — no need to click the group header, which would only toggle it shut.
  await wait(() => groupLinks().includes('UI Plugin'));

  b.click([...b.$$('.nav-sub-link')].find((a) => a.textContent.trim() === 'UI Plugin'));
  await wait(() => /#\/plugin-uiplug/.test(b.win.location.hash));
  await wait(() =>
    /Hello from the UI plugin/.test(b.$('section[x-data^="pluginScreen"]')?.textContent ?? ''),
  );

  b.go('#/plugins');
  await wait(() => sec('pluginsPage') && /Disable/.test(row()?.textContent ?? ''));
  b.click([...row().querySelectorAll('button')].find((x) => x.textContent === 'Disable'));
  await wait(() => /Enable/.test(row().textContent));
  await wait(() => !groupLinks().includes('UI Plugin'));
});
