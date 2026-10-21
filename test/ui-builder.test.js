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
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};

test('Webmaster is in the menu, with Site pages and Components', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  // Wait for the nav to actually be populated (permissions loaded, items rendered), not just the sidebar element to exist.
  await wait(() => /Site pages/.test(navText()));
  assert.match(navText(), /Components/);
});

test('Pages: the list shows the starter site, in a new page you can add components and save it', async () => {
  b.go('#/pages');
  const list = () => b.$('section[x-data="pagesList"]');
  await wait(() => list() && list().querySelectorAll('tbody tr').length > 3);
  assert.match(list().textContent, /\/blog/);

  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  setValue(ed().querySelector('#p-name'), 'ui-test-page');
  setValue(ed().querySelector('#p-title'), 'A page built in the browser');

  const addSelect = () => ed().querySelector('select[aria-label="Add a component"]');
  await wait(() => addSelect() && [...addSelect().options].some((o) => o.value === 'hero'));
  setValue(addSelect(), 'hero');
  const addBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add');
  await wait(() => addBtn());
  b.click(addBtn());
  await wait(() => /Hero banner/.test(ed().textContent));

  const headingInput = [...ed().querySelectorAll('label')]
    .find((l) => /Heading/.test(l.textContent))
    ?.closest('.mb-2')
    ?.querySelector('input, textarea');
  assert.ok(headingInput, 'the hero component’s Heading field is on the page');
  setValue(headingInput, 'Built from the page builder');

  await wait(() =>
    /Built from the page builder/.test(ed().querySelector('iframe')?.getAttribute('srcdoc') || ''),
  );

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create page');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-test-page.html'));
  const saved = node.ctx.siteFiles.get('pages/ui-test-page.html').content;
  assert.match(saved, /title: A page built in the browser/);
  assert.match(saved, /\{% render "hero", heading: "Built from the page builder" %\}/);
  // the address bar never shows the storage details: no "pages/" prefix, no ".html" suffix
  // The address changes when the save's response arrives, a moment after the row is in the database.
  await wait(() => b.win.location.hash === '#/pages/ui-test-page');
  assert.equal(b.win.location.hash, '#/pages/ui-test-page');

  // back on the list, the new page shows up, and can be deleted
  b.go('#/pages');
  await wait(() => list() && /ui-test-page/.test(list().textContent));
  const row = [...list().querySelectorAll('tbody tr')].find((r) =>
    /ui-test-page/.test(r.textContent),
  );
  b.click(row.querySelector('button.btn-outline-danger'));
  await wait(() => !node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-test-page.html'));
});

test('Pages: typing ".html" into the address is dropped, not doubled into a real /page.html address', async () => {
  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  const nameInput = ed().querySelector('#p-name');
  setValue(nameInput, 'extension-test.html');
  nameInput.dispatchEvent(new b.win.Event('blur', { bubbles: true }));
  await wait(() => nameInput.value === 'extension-test');

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create page');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/extension-test.html'));
  assert.ok(
    !node.ctx.siteFiles.list().some((f) => f.path === 'pages/extension-test.html.html'),
    'the typed .html was not doubled up',
  );
  await wait(() => b.win.location.hash === '#/pages/extension-test');
  assert.equal(b.win.location.hash, '#/pages/extension-test');

  await node.ctx.siteFiles.remove('pages/extension-test.html', null);
});

test('Components: the list shows the starter components, and a new one can be built and saved', async () => {
  b.go('#/components');
  const list = () => b.$('section[x-data="componentsList"]');
  await wait(() => list() && /hero/.test(list().textContent));

  b.go('#/components/new');
  const ed = () => b.$('section[x-data^="componentsEditor"]');
  await wait(() => ed() && ed().querySelector('#c-name'));
  // "Ask the assistant" is offered on a new component too (it opens the chat; there is nothing to pin yet).
  const askBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => /Ask the assistant/.test(x.textContent));
  await wait(() => askBtn() && b.visible(askBtn()));
  setValue(ed().querySelector('#c-name'), 'ui-test-widget');
  setValue(ed().querySelector('#c-title'), 'UI test widget');

  // The editor is grouped into tabs, like the page editor: only the open tab's fields are visible.
  const panes = () => [...ed().querySelectorAll('.pe-pane')].filter((p) => b.visible(p));
  assert.deepEqual(
    [...ed().querySelectorAll('.pe-tabs .nav-link')].map((x) => x.textContent.trim()),
    ['General', 'Properties & data', 'Template', 'Style', 'Preview'],
  );
  assert.equal(panes().length, 1);
  assert.ok(panes()[0].querySelector('#c-name'));
  b.click(ed().querySelector('[data-tab="data"]'));
  await wait(
    () => panes()[0]?.querySelector('input, button') && !panes()[0].querySelector('#c-name'),
  );
  assert.equal(panes().length, 1);

  const addProp = [...ed().querySelectorAll('button')].find(
    (x) => x.textContent === 'Add property',
  );
  b.click(addProp);
  await wait(() => ed().querySelector('.row.g-2.mb-2'));
  const propRow = ed().querySelector('.row.g-2.mb-2');
  setValue(propRow.querySelector('input[aria-label="Property key"]'), 'label');
  setValue(propRow.querySelector('input[aria-label="Default value"]'), 'Hi');

  setValue(ed().querySelector('#c-template'), '<p>{{ label }}</p>');

  await wait(() => /Hi/.test(ed().querySelector('iframe')?.getAttribute('srcdoc') || ''));

  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create component');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() =>
    node.ctx.siteFiles.list().some((f) => f.path === 'components/ui-test-widget.html'),
  );
  const saved = node.ctx.siteFiles.get('components/ui-test-widget.html').content;
  assert.match(saved, /"label"/);
  assert.match(saved, /<p>\{\{ label \}\}<\/p>/);

  await node.ctx.siteFiles.remove('components/ui-test-widget.html', null);
});

test('Components: a pasted library snippet is imported, with notes about what it needs', async () => {
  b.go('#/components');
  const list = () => b.$('section[x-data="componentsList"]');
  await wait(() => list() && /hero/.test(list().textContent));
  const open = [...list().querySelectorAll('button')].find(
    (x) => x.textContent === 'Import snippet',
  );
  b.click(open);
  await wait(() => b.visible(list().querySelector('#sn-html')));

  setValue(list().querySelector('#sn-html'), '<div x-data class="p-4 text-lg">Hi</div>');
  setValue(list().querySelector('#sn-name'), 'ui_snippet');
  const go = () =>
    [...list().querySelectorAll('button')].find((x) => x.textContent === 'Import as component');
  await wait(() => !go().disabled);
  b.click(go());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'components/ui_snippet.html'));
  await wait(() => /ui_snippet/.test(list().querySelector('tbody')?.textContent || ''));
  await wait(() => /Alpine/.test(list().querySelector('.alert-info')?.textContent || ''));
  assert.match(node.ctx.siteFiles.get('components/ui_snippet.html').content, /\.p-4\b/);

  await node.ctx.siteFiles.remove('components/ui_snippet.html', null);
});

test('Components: the Library lists a repository, previews one component and adds the ticked ones', async () => {
  const realFetch = b.win.fetch;
  const hostFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes('api.github.com'))
      return new globalThis.Response(
        JSON.stringify({
          tree: [
            { type: 'blob', path: 'public/examples/marketing/ctas/1.html' },
            { type: 'blob', path: 'public/examples/marketing/ctas/2.html' },
          ],
        }),
      );
    if (url.includes('raw.githubusercontent.com'))
      return new globalThis.Response('<p class="p-4 text-lg">lib item</p>');
    return hostFetch(u, init);
  };
  try {
    b.go('#/components');
    const list = () => b.$('section[x-data="componentsList"]');
    await wait(() => list() && /hero/.test(list().textContent));
    b.click([...list().querySelectorAll('button')].find((x) => x.textContent === 'Library'));
    await wait(() => list().querySelectorAll('input[aria-label^="Add "]').length === 2);
    const previewBtn = list().querySelector('.col-lg-5 button');
    b.click(previewBtn);
    await wait(() =>
      /lib item/.test(
        list().querySelector('iframe[title="Library component preview"]')?.getAttribute('srcdoc') ||
          '',
      ),
    );
    const boxes = list().querySelectorAll('input[aria-label^="Add "]');
    boxes[0].click();
    boxes[1].click();
    const add = () =>
      [...list().querySelectorAll('button')].find((x) =>
        /^Add 2 to my components/.test(x.textContent),
      );
    await wait(() => add() && !add().disabled);
    b.click(add());
    await wait(
      () =>
        node.ctx.siteFiles
          .list('components/')
          .filter((f) => f.path.includes('hyperui_marketing_ctas')).length === 2,
    );
    for (const f of node.ctx.siteFiles
      .list('components/')
      .filter((f) => f.path.includes('hyperui_')))
      await node.ctx.siteFiles.remove(f.path, null);
  } finally {
    globalThis.fetch = hostFetch;
    void realFetch;
  }
});

test('Pages: the list offers export and a .zip import', async () => {
  b.go('#/pages');
  const list = () => b.$('section[x-data="pagesList"]');
  await wait(() => list());
  const exportLink = [...list().querySelectorAll('a')].find((a) => a.textContent === 'Export .zip');
  assert.ok(exportLink);
  assert.equal(exportLink.getAttribute('href'), '/api/admin/site/pages/export');

  const input = list().querySelector('input[type="file"]');
  assert.ok(input);
  const zipBuffer = await node.ctx.siteFiles.exportZip('pages'); // a real, valid pages.zip
  Object.defineProperty(input, 'files', {
    value: [new b.win.File([zipBuffer], 'pages.zip', { type: 'application/zip' })],
    configurable: true,
  });
  input.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  await wait(() => /Import finished/.test(b.text()));
});

test('Page editor: six tabs, and Style / Scripts are saved with the page and read back (D-105)', async () => {
  b.go('#/pages/new');
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && ed().querySelector('#p-name'));
  assert.deepEqual(
    [...ed().querySelectorAll('.pe-tabs button')].map((x) => x.textContent.trim()),
    ['General', 'SEO', 'Code', 'Scripts', 'Style', 'Preview'],
  );
  setValue(ed().querySelector('#p-name'), 'ui-tabs');
  const alpine = () => b.win.Alpine.$data(ed());
  alpine().mode = 'code';
  alpine().code = '<h1>Tabs</h1>';
  alpine().css = 'h1 { color: red; }';
  alpine().js = 'window.__tabs = 1;';
  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create page');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-tabs.html'));
  const saved = node.ctx.siteFiles.get('pages/ui-tabs.html').content;
  assert.match(
    saved,
    /<h1>Tabs<\/h1>\n\n<style>\nh1 \{ color: red; \}\n<\/style>\n\n<script>\nwindow\.__tabs = 1;\n<\/script>/,
  );

  b.go('#/pages');
  b.go('#/pages/ui-tabs');
  await wait(() => ed() && alpine().loaded && alpine().css);
  assert.equal(alpine().css, 'h1 { color: red; }');
  assert.equal(alpine().js, 'window.__tabs = 1;');
  assert.equal(alpine().code, '<h1>Tabs</h1>'); // the blocks are lifted out of the markup tab
  assert.equal(alpine().dirty, false);
  b.go('#/pages'); // leave the editor before its file goes
  await wait(() => !ed());
  await node.ctx.siteFiles.remove('pages/ui-tabs.html', null);
});

test('Pages: the orange Templates button starts a NEW page from a template, filled into the editor and not saved until you save', async () => {
  b.go('#/pages');
  const list = () => b.$('section[x-data="pagesList"]');
  await wait(() => list() && list().querySelector('[x-data^="templatePicker"] button'));
  const slot = () => list().querySelector('[x-data^="templatePicker"]');
  const picker = () => b.win.Alpine.$data(slot());
  const orange = () =>
    [...slot().querySelectorAll('button.btn-orange')].find((x) => /Templates/.test(x.textContent));
  await wait(() => orange());
  assert.equal(picker().open, false);
  b.click(orange());
  await wait(() => picker().open === true);
  const rows = () => [...slot().querySelectorAll('button.pd-row')];
  await wait(() => rows().length >= 20);
  b.click(rows().find((r) => /FAQ/.test(r.textContent)));
  await wait(() => picker().tpl?.id === 'faq' && /Frequently asked/.test(picker().html));
  const use = () =>
    [...slot().querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Use this template',
    );

  // a taken address is refused in the panel, and nothing opens
  await node.ctx.siteFiles.put('pages/faq.html', '---\ntitle: Mine\n---\n<p>mine</p>', null);
  b.click(use());
  await wait(() => /already exists/.test(picker().error));
  assert.match(b.win.location.hash, /#\/pages$/);
  await node.ctx.siteFiles.remove('pages/faq.html', null);

  b.click(use());
  await wait(() => /#\/pages\/new$/.test(b.win.location.hash));
  const ed = () => b.$('section[x-data^="pagesEditor"]');
  await wait(() => ed() && b.win.Alpine.$data(ed()).loaded);
  const d = () => b.win.Alpine.$data(ed());
  assert.equal(d().pageName, 'faq');
  assert.equal(d().front.title, 'Frequently asked questions');
  assert.equal(d().mode, 'code');
  assert.match(d().code, /Frequently asked questions/);
  assert.match(d().css, /\.tpl details/, 'its style went to the Style tab');
  assert.equal(
    node.ctx.siteFiles.snapshot().files.has('pages/faq.html'),
    false,
    'nothing is saved yet',
  );

  // saving writes the page
  await d().save();
  await wait(() => node.ctx.siteFiles.snapshot().files.has('pages/faq.html'));
  await node.ctx.siteFiles.remove('pages/faq.html', null);
});

test('Components: New component asks what it should be, the AI writes and saves it, and the editor opens on it', async () => {
  const { createAiComponentWriter } = await import('../src/modules/site/component-ai.js');
  const asked = [];
  node.ctx.aiComponentWriter = createAiComponentWriter(node.ctx, {
    client: {
      messages: {
        async create(p) {
          asked.push(p.messages[0].content);
          return {
            content: [{ type: 'text', text: 'NAME: ui_ai_banner\n\n<p class="b">Banner</p>' }],
          };
        },
      },
    },
  });
  b.go('#/components');
  const list = () => b.$('section[x-data="componentsList"]');
  await wait(() => list() && /hero/.test(list().textContent));
  await wait(
    () => list().querySelector('#gen-panel') && !b.visible(list().querySelector('#gen-panel')),
  );
  b.click([...list().querySelectorAll('button')].find((x) => x.textContent === 'New component'));
  await wait(() => b.visible(list().querySelector('#gen-panel')));

  const go = () =>
    [...list().querySelectorAll('button')].find((x) => /Write it with AI/.test(x.textContent));
  assert.equal(go().disabled, true, 'needs a description first');
  setValue(list().querySelector('#gen-desc'), 'A slim banner announcing a sale');
  await wait(() => !go().disabled);
  b.click(go());

  await wait(() =>
    node.ctx.siteFiles.list().some((f) => f.path === 'components/ui_ai_banner.html'),
  );
  assert.match(asked[0], /slim banner announcing a sale/);
  // The editor opens on the saved component, and offers the assistant to refine it.
  const ed = () => b.$('section[x-data^="componentsEditor"]');
  await wait(() => ed() && ed().querySelector('#c-name')?.value === 'ui_ai_banner');
  await wait(() => /Banner/.test(ed().querySelector('#c-template')?.value || ''));

  await node.ctx.siteFiles.remove('components/ui_ai_banner.html', null);
});

test('Pages: New page asks what it should say, the AI writes and saves it, and the editor opens on it', async () => {
  const { createAiPageWriter } = await import('../src/modules/site/page-ai.js');
  node.ctx.aiPageWriter = createAiPageWriter(node.ctx, {
    client: {
      messages: {
        async create() {
          return {
            content: [
              {
                type: 'text',
                text: 'ADDRESS: ui-ai-page\n\n---\ntitle: AI page\n---\n<h1>Hi</h1>',
              },
            ],
          };
        },
      },
    },
  });
  b.go('#/pages');
  const list = () => b.$('section[x-data="pagesList"]');
  await wait(() => list() && /blog/.test(list().textContent));
  await wait(
    () => list().querySelector('#gen-panel') && !b.visible(list().querySelector('#gen-panel')),
  );
  b.click([...list().querySelectorAll('button')].find((x) => x.textContent === 'New page'));
  await wait(() => b.visible(list().querySelector('#gen-panel')));
  setValue(list().querySelector('#gen-desc'), 'A page that greets visitors');
  const go = () =>
    [...list().querySelectorAll('button')].find((x) => /Write it with AI/.test(x.textContent));
  await wait(() => !go().disabled);
  b.click(go());
  await wait(() => node.ctx.siteFiles.list().some((f) => f.path === 'pages/ui-ai-page.html'));
  await wait(() => /ui-ai-page/.test(b.win.location.hash));
  await node.ctx.siteFiles.remove('pages/ui-ai-page.html', null);
});
