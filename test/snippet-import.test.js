import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import {
  PLACEHOLDER_IMAGE,
  compileTailwind,
  convertSnippet,
  localizeScripts,
  replaceExternalImages,
  snippetAddress,
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
      html: '<div x-data="{o:false}" class="p-2" data-hs-overlay="#m"><img src="/img/a.png"></div>',
      name: 'needs',
    });
    const all = out.notes.join('\n');
    assert.match(all, /Alpine/);
    assert.match(all, /plugin/i);
    assert.match(all, /images/);
  });

  test('the Tailwind forms and typography plugin classes work, without resetting every input', async () => {
    const css = await compileTailwind(
      '<input class="form-input rounded"><input type="checkbox" class="form-checkbox"><article class="prose">x</article>',
    );
    assert.match(css, /\.form-input\b/);
    assert.match(css, /\.form-checkbox\b/);
    assert.match(css, /\.prose\b/);
    assert.doesNotMatch(css, /\[type='text'\]\s*[,{]|^input\s*[,{]/m, 'no element-wide form reset');
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

describe('Tailwind 4 snippets compile as written', () => {
  test('v4 class names, the important marker and gradients work, and the cascade layers are gone', async () => {
    const css = await compileTailwind(
      '<a class="rounded-xs shadow-xs bg-linear-to-r from-red-500 focus:ring-3 outline-hidden flex! md:-ml-2 group-hover:underline">x</a>',
    );
    assert.match(css, /\.rounded-xs\s*\{\s*border-radius: var\(--radius-xs\)/);
    assert.match(css, /\.md\\:-ml-2/);
    assert.match(css, /\.flex\\!/);
    assert.match(css, /linear-gradient\(var\(--tw-gradient-stops\)\)/);
    assert.doesNotMatch(css, /@layer/, "unlayered, so the rules beat Bootstrap's");
    assert.doesNotMatch(css, /:root/, ':root does not exist inside a component');
    assert.match(css, /:host\s*\{[^}]*--radius-xs/, 'theme values live on the component wrapper');
  });

  test('the theme values reach the rendered component through the wrapper', async () => {
    const out = await convertSnippet({
      html: '<a class="rounded-xs bg-indigo-600 p-2">x</a>',
      name: 'v4wrap',
    });
    const compiled = compileComponent('site:v4wrap', out.content);
    assert.match(compiled.css, /^\[data-c="[a-f0-9]{8}"\]\{[^}]*--color-indigo-600/m);
    assert.match(compiled.css, /--color-indigo-600\)/);
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

describe('the library catalog (HyperUI, PrebuiltUI)', () => {
  let node, admin;
  const realFetch = globalThis.fetch;
  /** @type {string[]} */
  let asked = [];
  const TREE = {
    tree: [
      { type: 'blob', path: 'public/examples/marketing/ctas/1.html' },
      { type: 'blob', path: 'public/examples/marketing/ctas/1-dark.html' },
      { type: 'blob', path: 'public/examples/marketing/ctas/2.html' },
      { type: 'blob', path: 'public/examples/application/tabs/1.html' },
      { type: 'blob', path: 'public/examples/application/tabs/notes.md' },
      { type: 'tree', path: 'public/examples/application' },
    ],
  };
  before(async () => {
    node = await makeNode();
    admin = await signedIn(node.app);
    globalThis.fetch = async (u, init) => {
      const url = String(u);
      if (!/api\.github\.com|raw\.githubusercontent\.com/.test(url)) return realFetch(u, init);
      asked.push(url);
      if (url.includes('api.github.com')) return new globalThis.Response(JSON.stringify(TREE));
      return new globalThis.Response(
        `<a class="rounded-xs p-2" href="#">${url.split('/').pop()}</a>`,
      );
    };
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await node.close();
  });
  const get = (q) => admin.get('/api/admin/site/components/catalog').query(q);

  test('lists the libraries, then one library grouped by category — without dark twins or non-HTML', async () => {
    const all = await get({});
    assert.deepEqual(
      all.body.sources.map((s) => s.id),
      ['hyperui', 'prebuiltui'],
    );
    const r = await get({ source: 'hyperui' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.count, 3);
    assert.deepEqual(
      r.body.categories.map((c) => c.id),
      ['application', 'marketing'],
    );
    const ctas = r.body.categories[1].groups[0];
    assert.deepEqual(
      ctas.items.map((i) => i.name),
      ['hyperui_marketing_ctas_1', 'hyperui_marketing_ctas_2'],
    );
    assert.equal(ctas.items[0].title, 'Ctas 1');
  });

  test('the listing is fetched once and then served from the cache', async () => {
    asked = [];
    await get({ source: 'hyperui' });
    await get({ source: 'hyperui' });
    assert.equal(asked.filter((u) => u.includes('api.github.com')).length, 0);
  });

  test('convert shows the result without saving; import saves, skips repeats, and only fetches listed files', async () => {
    const path = 'public/examples/marketing/ctas/1.html';
    const conv = await admin
      .post('/api/admin/site/components/catalog/convert')
      .send({ source: 'hyperui', path });
    assert.equal(conv.status, 200, JSON.stringify(conv.body));
    assert.match(conv.body.content, /"license": "MIT"/);
    assert.match(
      conv.body.content,
      /github\.com\/markmead\/hyperui\/blob\/main\/public\/examples\/marketing\/ctas\/1\.html/,
    );
    assert.ok(
      !node.ctx.siteFiles.list('components/').some((f) => f.path.includes('hyperui_')),
      'convert saves nothing',
    );

    const imp = (paths, extra = {}) =>
      admin
        .post('/api/admin/site/components/catalog/import')
        .send({ source: 'hyperui', paths, ...extra });
    const first = await imp([path, 'public/examples/application/tabs/1.html']);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.saved.length, 2);
    const again = await imp([path]);
    assert.deepEqual(again.body.skipped, ['hyperui_marketing_ctas_1']);
    const over = await imp([path], { overwrite: true });
    assert.equal(over.body.saved.length, 1);

    asked = [];
    const evil = await imp(['../../etc/passwd', 'public/examples/marketing/ctas/9.html']);
    assert.equal(evil.body.saved.length, 0);
    assert.equal(evil.body.errors.length, 2);
    assert.match(evil.body.errors[0].message, /not in the library/);
    assert.deepEqual(asked, [], 'nothing outside the listing is ever requested');
  });

  test('an unknown library, a GitHub outage and a missing permission each say what to do', async () => {
    assert.equal((await get({ source: 'nope' })).status, 422);
    const saved = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    try {
      const r = await get({ source: 'prebuiltui' });
      assert.equal(r.status, 422);
      assert.match(r.body.error.message, /Could not reach GitHub/);
    } finally {
      globalThis.fetch = saved;
    }
    const role = await node.ctx.users.createRole(
      { name: 'reader2', description: '', permissions: ['admin.access', 'components.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'reader2@example.com',
        name: 'r',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'reader2@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await reader.get('/api/admin/site/components/catalog')).status, 403);
  });
});

describe('what used to leave a library component half-drawn', () => {
  test('arbitrary variants (pseudo-elements like the range thumb, the details marker) produce CSS', async () => {
    // A full page, as the libraries publish them: reading its <body> re-serialises `&` as `&amp;`
    const out = await convertSnippet({
      html: `<!doctype html><html><head><script src="/component.js" defer></script></head><body class="p-6">
        <details class="group [&_summary::-webkit-details-marker]:hidden"><summary class="flex [&::-webkit-details-marker]:hidden">Q</summary>
        <input type="range" class="[&::-webkit-slider-thumb]:size-7 [&::-webkit-slider-thumb]:rounded-full"></details></body></html>`,
      name: 'faq_x',
    });
    // before: the classes reached Tailwind HTML-escaped (`[&amp;::…]`), so none of them produced a rule
    const css = parseComponent(out.content).css;
    assert.match(css, /::-webkit-slider-thumb/);
    assert.match(css, /::-webkit-details-marker/);
    assert.match(css, /summary::-webkit-details-marker/);
  });

  test('pictures from other websites become a placeholder, and the note says so', async () => {
    const out = await convertSnippet({
      html: `<section class="p-4"><img src="https://images.unsplash.com/photo-1?w=800" alt="Team" class="rounded">
        <img src="https://cdn.example.com/b.jpg" srcset="https://cdn.example.com/b.jpg 2x" alt="B"></section>`,
      name: 'team_pics',
    });
    assert.doesNotMatch(out.content, /unsplash|cdn\.example/);
    assert.ok(out.content.includes(PLACEHOLDER_IMAGE));
    assert.match(
      out.notes.join(' '),
      /2 pictures from images\.unsplash\.com, cdn\.example\.com were replaced/,
    );
    assert.match(out.content, /alt="Team"/, 'alt text is kept');
    // the placeholder is a data: image, which the site's policy allows
    assert.match(PLACEHOLDER_IMAGE, /^data:image\/svg\+xml,/);
  });

  test('a picture on the site itself, and plain text, are left alone', () => {
    const html = '<img src="/media/1/a.jpg" alt="Mine"><p>Hello</p>';
    const r = replaceExternalImages(html);
    assert.equal(r.markup, html);
    assert.deepEqual(r.notes, []);
  });

  test('a script loaded from a CDN is copied onto the site and the component points at the copy', async () => {
    const html = `<div><canvas id="c"></canvas><script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js"></script><script>new Chart(c)</script></div>`;
    const seen = [];
    const r = await localizeScripts(html, {
      mirror: async (url) => (seen.push(url), { url: '/lib/_cdn/abc123def456/chart.umd.min.js' }),
    });
    assert.deepEqual(seen, ['https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js']);
    assert.match(r.content, /<script src="\/lib\/_cdn\/abc123def456\/chart\.umd\.min\.js">/);
    assert.match(r.content, /<script>new Chart\(c\)<\/script>/, 'the inline script is untouched');
    assert.deepEqual(r.notes, []);
  });

  test('without permission to copy files, or if the copy fails, the script stays and the note explains', async () => {
    const html = '<script src="https://cdn.example.com/lib.js"></script>';
    const none = await localizeScripts(html, {});
    assert.equal(none.content, html);
    assert.match(none.notes[0], /libraries\.manage/);
    const failed = await localizeScripts(html, {
      mirror: async () => {
        throw new Error('That address is not reachable.');
      },
    });
    assert.equal(failed.content, html);
    assert.match(failed.notes[0], /not reachable/);
    const off = await localizeScripts(html, {
      mirror: async () => ({
        url: '/lib/_cdn/x/lib.js',
        note: 'It is a script, and library scripts are off (Settings → Libraries).',
      }),
    });
    assert.match(off.notes[0], /library scripts are off/);
  });

  test('the note on a CDN script says where it is loaded from, and that previews show layout only', async () => {
    const out = await convertSnippet({
      html: '<div class="p-2"><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></div>',
      name: 'chart_x',
    });
    assert.match(out.notes.join(' '), /cdn\.jsdelivr\.net/);
    assert.match(out.notes.join(' '), /preview shows its layout only/);
  });
});
