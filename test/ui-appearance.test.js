import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { startRegistry } from './fake-registry.js';

let node, b, reg;
before(async () => {
  reg = await startRegistry();
  reg.add('demo-icons', '1.0.0', {
    'package.json': { style: 'css/icons.css', description: 'Demo icons' },
    'css/icons.css': '.i{}',
  });
  node = await makeNode();
  await node.ctx.settings.update('libraries', { values: { registry_url: reg.url } }, null);
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
  await reg.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const input = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};
const btn = (root, label) =>
  [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
/** The sub-links of the menu group that is open on screen (the one holding the current screen). */
const openGroupLinks = () =>
  b
    .$$('.nav-sub')
    .filter(b.visible)
    .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map((a) => a.textContent.trim()));

test('the menu: themes and their tools under Appearance; sitemap and libraries under System', async () => {
  b.go('#/customize');
  await wait(() => openGroupLinks().includes('Customize'));
  assert.deepEqual(openGroupLinks(), ['Themes', 'Customize', 'Theme editor', 'Menus']);
  b.go('#/sitemap');
  await wait(() => openGroupLinks().includes('Sitemap'));
  assert.deepEqual(openGroupLinks().slice(-6), [
    'Translations',
    'Redirects',
    'Messages',
    'Sitemap',
    'Libraries',
    'Database',
  ]);
});

test('Customize: type custom CSS, see it in the preview, save it, and visitors get it', async () => {
  b.go('#/customize/default');
  const page = () => b.$('section[x-data="customizePage"]');
  await wait(() => page()?.querySelector('iframe')?.getAttribute('srcdoc')?.includes('</html>'));
  input(page().querySelector('#cz-css'), '.ui-custom-css{color:red}');
  await wait(() =>
    page().querySelector('iframe').getAttribute('srcdoc').includes('.ui-custom-css{color:red}'),
  );
  assert.equal(node.ctx.settings.get('theme_default.custom_css'), '', 'not saved yet');
  const save = () => btn(page(), 'Save changes');
  await wait(() => save() && !save().disabled);
  b.click(save());
  await wait(
    () => node.ctx.settings.get('theme_default.custom_css') === '.ui-custom-css{color:red}',
  );
  assert.match(await (await fetch(`${node.url}/`)).text(), /\.ui-custom-css\{color:red\}/);

  input(page().querySelector('#cz-css'), 'a{}</style>');
  await wait(() => b.alertShown(/markup/) || /markup/.test(page().textContent));
});

test('Theme editor: a built-in theme is read-only; duplicate it, then edit and save a file', async () => {
  b.win.prompt = () => 'ui_copy';
  b.go('#/theme-editor/default');
  const page = () => b.$('section[x-data="themeEditorPage"]');
  await wait(() => page() && b.alertShown(/Built-in themes ship read-only/));
  b.click(btn(page(), 'Duplicate this theme'));
  await wait(() => node.ctx.themes.has('ui_copy'));
  await wait(() => page().querySelector('#te-content') && !b.alertShown(/read-only/));
  const css = () =>
    [...page().querySelectorAll('.te-file')].find((x) => /styles\/.*\.css/.test(x.textContent));
  await wait(() => css());
  b.click(css());
  await wait(() => page().querySelector('.panel-h .mono')?.textContent.startsWith('styles/'));
  const area = page().querySelector('#te-content');
  await wait(() => area.value.length > 0);
  input(area, `${area.value}\n.saved-from-ui{}`);
  const save = () => btn(page(), 'Save file');
  await wait(() => save() && !save().disabled);
  b.click(save());
  await wait(async () => {
    const rt = await node.ctx.themes.runtime('ui_copy');
    return [...rt.files.values()].some((f) => String(f.content).includes('.saved-from-ui{}'));
  });
});

test('Sitemap: the screen shows the count, and an extra address saved there is listed', async () => {
  b.go('#/sitemap');
  const page = () => b.$('section[x-data="sitemapPage"]');
  await wait(() => page() && Number(page().querySelector('#sm-total')?.textContent) > 0);
  input(page().querySelector('#sm-extra'), '/from-the-ui');
  b.click(btn(page(), 'Save changes'));
  await wait(() => node.ctx.settings.get('sitemap.extra_urls').includes('/from-the-ui'));
  assert.match(await (await fetch(`${node.url}/sitemap.xml`)).text(), /\/from-the-ui<\/loc>/);
  await wait(() => /\/from-the-ui/.test(page().querySelector('table').textContent));
});

test('Libraries: install a package by name; it is listed and its stylesheet is chosen', async () => {
  b.go('#/libraries');
  const page = () => b.$('section[x-data="librariesPage"]');
  await wait(() => page()?.querySelector('#lib-name'));
  input(page().querySelector('#lib-name'), 'demo-icons');
  b.click(btn(page(), 'Install'));
  await wait(() => node.ctx.libraries.list().some((l) => l.name === 'demo-icons'));
  const lib = node.ctx.libraries.list().find((l) => l.name === 'demo-icons');
  assert.equal(lib.autoload, true, '"Load on every page" is ticked by default');
  assert.deepEqual(lib.include, ['css/icons.css']);
  await wait(() =>
    /demo-icons/.test(page().querySelector('table:not(.table-sm)')?.textContent ?? ''),
  );
  assert.match(
    await (await fetch(`${node.url}/`)).text(),
    /<link rel="stylesheet" href="\/lib\/demo-icons@1\.0\.0\/css\/icons\.css">/,
  );
});

test('preview frames keep the site origin (so theme files load) and nothing more', async () => {
  // Theme, library and media files are served with Cross-Origin-Resource-Policy: same-origin. An empty sandbox gives a
  // frame a "null" origin, and real browsers then block every one of them (jsdom doesn't, so this checks the attribute).
  const html = await (await fetch(`${node.url}/admin`)).text();
  const frames = [...html.matchAll(/<iframe title="([^"]+)"[^>]*sandbox="([^"]*)"/g)];
  assert.deepEqual(
    frames.map((m) => m[1]),
    ['Page preview', 'Component preview', 'Theme preview'],
  );
  for (const [, title, sandbox] of frames) assert.equal(sandbox, 'allow-same-origin', title);
});
