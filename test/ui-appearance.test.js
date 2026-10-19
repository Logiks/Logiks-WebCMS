import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { startRegistry } from './fake-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  // Let customizePage's own async chain (its history.replaceState to the default theme id, then its
  // preview refresh()) fully settle before navigating away — leaving it in flight desyncs jsdom's
  // history state against real (non-instant) DB latency and the next hashchange silently never fires
  // (reproduces reliably against MySQL/PostgreSQL, never against SQLite).
  await wait(() =>
    b
      .$('section[x-data="customizePage"]')
      ?.querySelector('iframe')
      ?.getAttribute('srcdoc')
      ?.includes('</html>'),
  );
  b.go('#/sitemap');
  await wait(() => openGroupLinks().includes('Sitemap'));
  assert.deepEqual(openGroupLinks().slice(-8), [
    'Translations',
    'Redirects',
    'Messages',
    'Sitemap',
    'Libraries',
    'Database',
    'API',
    'Modules',
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
  b.go('#/theme-editor/default');
  const page = () => b.$('section[x-data="themeEditorPage"]');
  await wait(() => page() && b.alertShown(/Built-in themes ship read-only/));
  b.click(btn(page(), 'Duplicate this theme'));
  await wait(
    () =>
      page().querySelector('#dup-name')?.offsetParent !== undefined &&
      page().querySelector('#dup-id'),
  );
  // The name typed in the dialog is the name the copy gets, and the id follows it until edited.
  input(page().querySelector('#dup-name'), 'My Own Theme');
  await wait(() => page().querySelector('#dup-id').value === 'my_own_theme');
  input(page().querySelector('#dup-id'), 'ui_copy');
  b.click(btn(page(), 'Create copy'));
  await wait(() => node.ctx.themes.has('ui_copy'));
  assert.equal(node.ctx.themes.list().find((t) => t.id === 'ui_copy').name, 'My Own Theme');
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
  // Each module owns its own admin-screen markup (fetched lazily, never in the shell's raw HTML), so this fetches the
  // shell plus every module's fragment over HTTP, the same way the SPA itself does, rather than assuming one file.
  const shell = await (await fetch(`${node.url}/admin`)).text();
  const modulesDir = path.join(ROOT, 'src/modules');
  const fragments = await Promise.all(
    fs
      .readdirSync(modulesDir)
      .flatMap((mod) => {
        const dir = path.join(modulesDir, mod, 'admin');
        return fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => `${mod}/${file}`) : [];
      })
      .map(async (rel) => (await fetch(`${node.url}/admin/modules/${rel}`)).text()),
  );
  const html = [shell, ...fragments].join('\n');
  const frames = [...html.matchAll(/<iframe title="([^"]+)"[^>]*sandbox="([^"]*)"/g)];
  // Order is just an artifact of which module's directory sorts where — not a meaningful invariant.
  assert.deepEqual(frames.map((m) => m[1]).sort(), [
    'Component preview',
    'Page preview', // the page editor
    'Page preview', // the AI Page Designer chat
    'Theme preview',
  ]);
  for (const [, title, sandbox] of frames) assert.equal(sandbox, 'allow-same-origin', title);
});

test('Themes: duplicating asks for a name and uses it (it used to force "<name> (copy)")', async () => {
  b.go('#/themes');
  const page = () => b.$('section[x-data="themesPage"]');
  await wait(() => page() && btn(page(), 'Duplicate'));
  b.click(btn(page(), 'Duplicate'));
  await wait(() => page().querySelector('#dup-name'));
  assert.match(
    page().querySelector('#dup-name').value,
    /\(copy\)$/,
    'a sensible default is offered',
  );
  input(page().querySelector('#dup-name'), 'Brand Blue');
  await wait(() => page().querySelector('#dup-id').value === 'brand_blue');
  b.click(btn(page(), 'Create copy'));
  await wait(() => node.ctx.themes.has('brand_blue'));
  assert.equal(node.ctx.themes.list().find((t) => t.id === 'brand_blue').name, 'Brand Blue');
  await wait(() =>
    [...page().querySelectorAll('strong')].some((x) => x.textContent === 'Brand Blue'),
  );
});

test('Themes: a bad id is refused with the reason, and the dialog stays open', async () => {
  b.go('#/themes');
  const page = () => b.$('section[x-data="themesPage"]');
  await wait(() => page() && btn(page(), 'Duplicate'));
  b.click(btn(page(), 'Duplicate'));
  await wait(() => page().querySelector('#dup-id'));
  input(page().querySelector('#dup-id'), 'brand_blue'); // already taken by the previous test
  b.click(btn(page(), 'Create copy'));
  await wait(() => /already exists/.test(page().querySelector('.modal-card').textContent));
});
