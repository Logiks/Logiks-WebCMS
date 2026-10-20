import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import {
  compileTailwind,
  convertSnippet,
  snippetAddress,
  v4ToV3,
} from '../src/modules/site/snippet.js';
import {
  SiteFormatError,
  compileComponent,
  parseComponent,
} from '../src/modules/site/component.js';

const HERO = `<section class="bg-white px-4 py-8 hover:bg-gray-50 dark:bg-gray-900">
  <h1 class="text-3xl font-extrabold sm:text-5xl">Hello</h1>
  <a class="group inline-flex rounded-sm bg-indigo-600 px-8 py-3 text-white" href="#">Go</a>
</section>`;

describe('convertSnippet: a library snippet becomes a component file', () => {
  test('keeps only the utilities the markup uses, with no global reset', async () => {
    const css = await compileTailwind(HERO);
    assert.match(css, /\.px-4\b/);
    assert.match(css, /\.hover\\:bg-gray-50:hover/);
    assert.match(css, /prefers-color-scheme: dark/);
    assert.doesNotMatch(css, /\.mt-4\b/, 'a utility nothing uses is not emitted');
    assert.doesNotMatch(css, /\bbody\s*\{|\bhtml\s*\{|button\s*,/, 'no preflight reset');
    assert.doesNotMatch(css, /::backdrop/);
    assert.ok(css.length < 6000, `css stays small (${css.length} bytes)`);
  });

  test('the result is a valid component that the site can compile and scope', async () => {
    const out = await convertSnippet({
      html: HERO,
      name: 'hero-one',
      sourceUrl: 'https://github.com/markmead/hyperui/blob/main/x.html',
      license: 'MIT',
    });
    assert.equal(out.path, 'components/hero_one.html');
    const parsed = parseComponent(out.content);
    assert.equal(parsed.meta.license, 'MIT');
    assert.match(parsed.meta.source, /hyperui/);
    const compiled = compileComponent('site:hero_one', out.content);
    const selectors = [...compiled.css.matchAll(/(?:^|[}{])\s*([^{}@][^{}]*)\{/g)].map((m) =>
      m[1].trim(),
    );
    assert.ok(selectors.length > 5);
    for (const sel of selectors)
      for (const one of sel.split(','))
        assert.match(one.trim(), /^\[data-c="[a-f0-9]{8}"\]/, `scoped: ${one}`);
  });

  test('Liquid-looking text in a snippet is shown, not run', async () => {
    const out = await convertSnippet({
      html: '<p class="p-2">Total {{ count }} {% if x %}</p>',
      name: 'braces',
    });
    assert.doesNotThrow(() => parseComponent(out.content));
    // The Liquid engine must render the braces back out as literal text.
    const { Liquid } = await import('liquidjs');
    const text = await new Liquid().parseAndRender(parseComponent(out.content).template);
    assert.equal(text, '<p class="p-2">Total {{ count }} {% if x %}</p>');
  });

  test('a whole HTML page is reduced to its body and the Tailwind browser script is dropped', async () => {
    const out = await convertSnippet({
      html: '<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body><div class="p-4">x</div></body></html>',
      name: 'wrapped',
    });
    const { template } = parseComponent(out.content);
    assert.equal(template, '<div class="p-4">x</div>');
  });

  test('says what the site may be missing: Alpine, plugins, images', async () => {
    const out = await convertSnippet({
      html: '<div x-data="{o:false}" class="form-input p-2"><img src="/img/a.png"></div>',
      name: 'needs',
    });
    const all = out.notes.join('\n');
    assert.match(all, /Alpine/);
    assert.match(all, /plugin/i);
    assert.match(all, /images/);
  });

  test('names are slugged; empty or oversized snippets are refused with a fix', async () => {
    assert.equal(
      (await convertSnippet({ html: '<p>x</p>', name: 'Newsletter Signup #2' })).name,
      'newsletter_signup_2',
    );
    await assert.rejects(convertSnippet({ html: '  ', name: 'a' }), SiteFormatError);
    await assert.rejects(convertSnippet({ html: 'x'.repeat(250_000), name: 'a' }), /smaller piece/);
    await assert.rejects(convertSnippet({ html: '<p>x</p>', name: '###' }), /name/);
  });

  test('a title that tries to close the meta block cannot', async () => {
    const out = await convertSnippet({ html: '<p>x</p>', name: 'evil', title: '</script><b>' });
    assert.equal(parseComponent(out.content).meta.title, '</script><b>');
  });
});

describe('Tailwind 4 snippets are translated to the sizes Tailwind 3 means', () => {
  test('renamed scale steps and the important marker', () => {
    const { html, converted } = v4ToV3(
      '<a class="rounded-sm shadow-xs hover:rounded-xs bg-linear-to-r focus:ring-3 outline-hidden flex! md:-ml-2">x</a>',
    );
    assert.equal(converted, true);
    assert.equal(
      html,
      '<a class="rounded shadow-sm hover:rounded-sm bg-gradient-to-r focus:ring outline-none !flex md:-ml-2">x</a>',
    );
  });

  test('a Tailwind 3 snippet is left exactly as written', () => {
    const src = '<a class="rounded-sm shadow-sm ring blur">x</a>';
    assert.deepEqual(v4ToV3(src), { html: src, converted: false });
  });

  test('the import tells the author it happened', async () => {
    const out = await convertSnippet({ html: '<a class="rounded-xs p-2">x</a>', name: 'v4' });
    assert.match(out.notes.join(' '), /Tailwind 4/);
  });
});

describe('fetching a snippet by link', () => {
  test('only GitHub links, and a github.com file page becomes its raw twin', () => {
    assert.equal(
      snippetAddress(
        'https://github.com/markmead/hyperui/blob/main/public/components/marketing/ctas/1.html',
      ),
      'https://raw.githubusercontent.com/markmead/hyperui/main/public/components/marketing/ctas/1.html',
    );
    assert.equal(
      snippetAddress('https://raw.githubusercontent.com/a/b/main/x.html'),
      'https://raw.githubusercontent.com/a/b/main/x.html',
    );
  });

  for (const bad of [
    'http://raw.githubusercontent.com/a/b/main/x.html',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost:3000/x',
    'https://evil.example.com/x.html',
    'https://raw.githubusercontent.com.evil.example/x.html',
    'https://user:pw@raw.githubusercontent.com/a/b/main/x.html',
    'https://github.com/markmead/hyperui',
    'not a url',
  ])
    test(`refuses ${bad}`, () => {
      assert.throws(() => snippetAddress(bad), SiteFormatError);
    });
});

describe('POST /site/components/import-snippet', () => {
  let node, admin;
  before(async () => {
    node = await makeNode();
    admin = await signedIn(node.app);
  });
  after(() => node.close());
  const post = (body) => admin.post('/api/admin/site/components/import-snippet').send(body);

  test('creates the component, which then renders with its CSS in a real page', async () => {
    const r = await post({ html: HERO, name: 'hero_tw', title: 'Hero (Tailwind)', license: 'MIT' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.path, 'components/hero_tw.html');
    const list = await admin.get('/api/admin/site/components');
    const c = list.body.components.find((x) => x.name === 'hero_tw');
    assert.equal(c.meta.title, 'Hero (Tailwind)');

    const page = await admin.post('/api/admin/site/preview').send({
      mode: 'page',
      path: 'pages/tw-demo.html',
      content: '---\ntitle: Demo\nuses: none\n---\n{% render "hero_tw" %}',
    });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.match(page.body.html, /text-5xl|sm:text-5xl/);
    assert.match(page.body.html, /data-c="[a-f0-9]{8}"/);
    assert.match(page.body.html, /\.px-4\{/);
  });

  test('a second import with the same name is refused unless replacing is asked for', async () => {
    const again = await post({ html: HERO, name: 'hero_tw' });
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /already exists/);
    const replaced = await post({
      html: '<p class="p-9">new</p>',
      name: 'hero_tw',
      overwrite: true,
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.created, false);
  });

  test('bad input says what to fix', async () => {
    assert.equal((await post({ name: 'x' })).status, 422);
    const off = await post({ url: 'https://evil.example.com/a.html', name: 'x' });
    assert.equal(off.status, 422);
    assert.match(off.body.error.message, /GitHub/);
  });

  test('a link is fetched (GitHub only) and its address is kept as the source', async () => {
    const real = globalThis.fetch;
    /** @type {string[]} */
    const asked = [];
    globalThis.fetch = async (u) => {
      asked.push(String(u));
      return new globalThis.Response('<div class="p-3">from github</div>', { status: 200 });
    };
    try {
      const r = await post({
        url: 'https://github.com/markmead/hyperui/blob/main/public/components/x/1.html',
        license: 'MIT',
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(asked, [
        'https://raw.githubusercontent.com/markmead/hyperui/main/public/components/x/1.html',
      ]);
      assert.equal(r.body.name, '1'.replace(/^/, 'c_'));
      const f = await admin.get('/api/admin/site/file').query({ path: r.body.path });
      assert.match(f.body.content, /raw\.githubusercontent\.com\/markmead/);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('needs components.write', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'reader', description: '', permissions: ['admin.access', 'components.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'reader@example.com',
        name: 'r',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'reader@example.com',
      password: 'Some-long-pass-12',
    });
    const r = await reader
      .post('/api/admin/site/components/import-snippet')
      .send({ html: '<p>x</p>', name: 'nope' });
    assert.equal(r.status, 403);
  });
});
