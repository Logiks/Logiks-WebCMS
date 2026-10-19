import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';
import { createAiTranslator } from '../src/modules/site/translate.js';

let node;
before(async () => {
  node = await makeNode();
});
after(() => node.close());

test('Translations: edit wording in the default language, add a language, and the site shows it', async () => {
  const b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.go('#/locales');
  const page = () => b.$('section[x-data="localesPage"]');
  await until(() => page() && page().querySelectorAll('tbody tr').length > 5);
  assert.match(page().textContent, /blog\.title/);
  assert.ok(
    b.$$('nav a, aside a').some((a) => /Translations/.test(a.textContent)),
    'it is in the menu',
  );

  const rowOf = (key) =>
    [...page().querySelectorAll('tbody tr')].find((r) => r.children[0].textContent === key);
  const input = (key) => rowOf(key).querySelector('input');
  b.type(input('blog.title'), 'Journal');
  await until(() => /1 changed/.test(page().textContent));
  b.click(b.button('Save translations'));
  await until(
    () =>
      node.ctx.siteFiles.snapshot().files.has('locales/en.json') &&
      JSON.parse(node.ctx.siteFiles.get('locales/en.json').content).blog?.title === 'Journal',
  );
  await until(() => /Translations saved/.test(b.text()));

  // a new language: every string is missing, with the default language as the reference
  b.type(page().querySelector('input[aria-label="New language code"]'), 'fr');
  b.click(b.button('Add language'));
  await until(
    () =>
      /français|fr/.test(page().querySelector('.panel-h span').textContent) && rowOf('blog.title'),
  );
  assert.equal(
    rowOf('blog.title').children[1].textContent,
    'Journal',
    'the reference is the default language',
  );
  b.type(input('blog.title'), 'Carnet');
  b.click(b.button('Save translations'));
  await until(() => node.ctx.siteFiles.snapshot().files.has('locales/fr.json'));
  assert.deepEqual(JSON.parse(node.ctx.siteFiles.get('locales/fr.json').content), {
    blog: { title: 'Carnet' },
  });

  b.type(page().querySelector('input[aria-label="New language code"]'), 'Bad Code');
  b.click(b.button('Add language'));
  await until(() => /looks like fr, hi or en-IN/.test(page().textContent));
  assert.deepEqual(b.errors, []);
  b.close();
});

test('Translations: "Translate with AI" fills a new language, flags it as AI, and "Mark all as checked" clears the flag', async () => {
  node.ctx.aiTranslator = createAiTranslator(node.ctx, {
    client: {
      messages: {
        async create({ messages }) {
          const input = JSON.parse(messages[0].content.slice(messages[0].content.indexOf('{')));
          const out = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, `de:${v}`]));
          return { content: [{ type: 'text', text: JSON.stringify(out) }] };
        },
      },
    },
  });
  const b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  b.go('#/locales');
  const page = () => b.$('section[x-data="localesPage"]');
  await until(() => page() && page().querySelectorAll('tbody tr').length > 5);
  const shown = (el) => {
    for (let n = el; n && n !== page().parentNode; n = n.parentNode)
      if (n.style?.display === 'none') return false;
    return true;
  };
  const visible = (sel) => [...page().querySelectorAll(sel)].filter(shown);
  assert.equal(visible('button').filter((x) => /Translate with AI/.test(x.textContent)).length, 0);

  b.type(page().querySelector('input[aria-label="New language code"]'), 'de');
  b.click(b.button('Add language'));
  await until(() => visible('button').some((x) => /Translate with AI/.test(x.textContent)));
  b.click(visible('button').find((x) => /Translate with AI/.test(x.textContent)));
  await until(() => /marked AI until you check/.test(page().textContent));
  await until(() => visible('tbody .badge').length > 0);
  assert.ok(node.ctx.siteFiles.snapshot().files.has('locales/de.json'));

  b.click(b.button('Mark all as checked'));
  await until(() => visible('tbody .badge').length === 0);
  assert.deepEqual(b.errors, []);
  b.close();
});
