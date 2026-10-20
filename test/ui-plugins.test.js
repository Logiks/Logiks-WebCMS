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
  'plugin.js':
    "export default (ctx) => { const { Router } = ctx.require('express'); const r = Router(); r.get('/ping', (req, res) => res.json({ ok: true })); return r; };",
  'admin/index.html': '<div data-testid="uiplug-screen">Hello from the UI plugin</div>',
});

const PLUGIN_TWO = zipOf({
  'plugin.json': JSON.stringify({
    slug: 'uiplug-two',
    name: 'UI Plugin Two',
    version: '1.0.0',
    author: 'Test',
    description: 'A second UI test plugin, to switch to from the first.',
    menu: { label: 'UI Plugin Two', icon: 'bi-puzzle' },
    permissions: [],
  }),
  'admin/index.html': '<div data-testid="uiplug-two-screen">Hello from the SECOND UI plugin</div>',
});

const CONFIGURED_PLUGIN = zipOf({
  'plugin.json': JSON.stringify({
    slug: 'configplug',
    name: 'Config Plugin',
    version: '1.0.0',
    author: 'Test',
    description: 'A UI test plugin with its own config.',
    config: {
      greeting: { type: 'string', label: 'Greeting', default: 'Hello' },
    },
  }),
});

const groupLinks = () =>
  b
    .$$('.nav-sub')
    .filter(b.visible)
    .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map((a) => a.textContent.trim()));

test('Plugin Manager is under Settings (Plugin Editor is a button inside it, not its own nav entry, D-063); Applications has no group until a plugin has a screen', async () => {
  b.go('#/overview');
  await wait(() => b.button('Settings'));
  assert.equal(b.button('Applications'), undefined, 'no plugin screens, no Applications group');
  b.click(b.button('Settings'));
  await wait(() => groupLinks().length);
  assert.deepEqual(groupLinks(), ['All settings', 'Features', 'Plugin Manager']);
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

  // The plugin's own entry appears under Applications, which only exists now: open it.
  await wait(() => b.button('Applications'));
  b.click(b.button('Applications'));
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

// Regression: a real bug reported live — clicking from one enabled plugin's nav item straight to another's left
// the FIRST plugin's screen showing (only a full page reload picked up the new one). `route.startsWith('plugin-')`
// stayed true across both clicks, so the <template x-if> wrapping `pluginScreen(route.slice(7))` never tore down
// and recreated the section — `slug` is only ever read once, at x-data creation.
test('switching from one enabled plugin straight to another updates the screen without a reload', async () => {
  b.go('#/plugins');
  await wait(() => sec('pluginsPage'));

  // uiplug was left disabled at the end of the previous test — re-enable it instead of reinstalling.
  const rowFor = (name) =>
    [...sec('pluginsPage').querySelectorAll('tr')].find((r) =>
      new RegExp(name).test(r.textContent),
    );
  b.click(
    [...rowFor('UI Plugin').querySelectorAll('button')].find((x) => x.textContent === 'Enable'),
  );
  await wait(() => /Disable/.test(rowFor('UI Plugin').textContent));

  chooseFiles(sec('pluginsPage').querySelector('input[type="file"]'), [
    file(PLUGIN_TWO, 'uiplug-two.zip', 'application/zip'),
  ]);
  await wait(() => rowFor('UI Plugin Two'));
  b.click(
    [...rowFor('UI Plugin Two').querySelectorAll('button')].find((x) => x.textContent === 'Enable'),
  );
  await wait(() => /Disable/.test(rowFor('UI Plugin Two').textContent));

  await wait(() => groupLinks().includes('UI Plugin') && groupLinks().includes('UI Plugin Two'));
  const navLink = (label) => [...b.$$('.nav-sub-link')].find((a) => a.textContent.trim() === label);

  b.click(navLink('UI Plugin'));
  await wait(() => /#\/plugin-uiplug$/.test(b.win.location.hash));
  await wait(() =>
    /Hello from the UI plugin\b/.test(b.$('section[x-data^="pluginScreen"]')?.textContent ?? ''),
  );

  // No reload — straight from one plugin screen to the other.
  b.click(navLink('UI Plugin Two'));
  await wait(() => /#\/plugin-uiplug-two$/.test(b.win.location.hash));
  await wait(() =>
    /Hello from the SECOND UI plugin/.test(
      b.$('section[x-data^="pluginScreen"]')?.textContent ?? '',
    ),
  );
  assert.doesNotMatch(
    b.$('section[x-data^="pluginScreen"]').textContent,
    /Hello from the UI plugin\b/,
  );

  // And back the other way, same check.
  b.click(navLink('UI Plugin'));
  await wait(() => /#\/plugin-uiplug$/.test(b.win.location.hash));
  await wait(() =>
    /Hello from the UI plugin\b/.test(b.$('section[x-data^="pluginScreen"]')?.textContent ?? ''),
  );
  assert.doesNotMatch(b.$('section[x-data^="pluginScreen"]').textContent, /SECOND UI plugin/);
});

test('a plugin with a config block gets a "Configure" button that edits its plugin_<slug> settings', async () => {
  b.go('#/plugins');
  await wait(() => sec('pluginsPage'));
  chooseFiles(sec('pluginsPage').querySelector('input[type="file"]'), [
    file(CONFIGURED_PLUGIN, 'configplug.zip', 'application/zip'),
  ]);
  await wait(() => /Config Plugin/.test(sec('pluginsPage').textContent));

  const row = () =>
    [...sec('pluginsPage').querySelectorAll('tr')].find((r) => /Config Plugin/.test(r.textContent));
  const configureBtn = () =>
    [...row().querySelectorAll('button')].find((x) => x.textContent === 'Configure');
  await wait(() => configureBtn());
  b.click(configureBtn());

  const panel = () => sec('pluginsPage').querySelector('#pc_greeting');
  await wait(() => panel());
  assert.equal(panel().value, 'Hello');

  panel().value = 'Howdy';
  panel().dispatchEvent(new b.win.Event('input', { bubbles: true }));
  const saveBtn = () =>
    [...sec('pluginsPage').querySelectorAll('button')].find(
      (x) => x.textContent === 'Save settings',
    );
  b.click(saveBtn());
  await wait(() => node.ctx.settings.get('plugin_configplug.greeting') === 'Howdy');

  // the generic Settings screen reaches the same namespace too (zero new UI code for it, D-061)
  b.go('#/settings');
  await wait(() =>
    /Plugin: Config Plugin/.test(b.$('section[x-data^="settingsPage"]')?.textContent ?? ''),
  );
});
