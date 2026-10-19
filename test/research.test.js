/* global Response */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { createResearch } from '../src/modules/research/service.js';
import { createWebAccess, extractPage } from '../src/modules/research/web.js';
import { createAssistant } from '../src/modules/assistant/service.js';
import { createGuide, GUIDE_SCREEN_IDS } from '../src/modules/assistant/guide.js';

let node, admin, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-research-'));
  node = await makeNode({ env: { MEDIA_DIR: dir } });
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const publicDns = async () => [{ address: '93.184.216.34' }];

/** Answers by address from a table; records what was asked. Never touches the network. */
const fakeWeb = (table) => {
  const asked = [];
  const f = async (url) => {
    const u = String(url);
    asked.push(u);
    const hit = table[u];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200, headers: hit.headers ?? {} });
  };
  f.asked = asked;
  return f;
};

const HTML = `<html><head><title>Rice &amp; Spice</title>
<meta property="og:image" content="/hero.jpg"><meta name="description" content="About rice">
<style>p{color:red}</style><script>alert(1)</script></head>
<body><nav>Menu stuff</nav><h1>Rice</h1><p>Grown in <b>Odisha</b>.</p><img src="/a.png" alt="A field">
<img src="data:image/gif;base64,AAAA"><img src="/logo.png"></body></html>`;

describe('reading a page', () => {
  test('extractPage keeps the article text and pictures, drops scripts, menus and tracking images', () => {
    const p = extractPage(HTML, 'https://example.com/post');
    assert.equal(p.title, 'Rice & Spice');
    assert.equal(p.description, 'About rice');
    assert.match(p.text, /Rice\nGrown in Odisha\./);
    assert.doesNotMatch(p.text, /alert|Menu stuff|color:red/);
    assert.deepEqual(
      p.images.map((i) => i.src),
      ['https://example.com/hero.jpg', 'https://example.com/a.png'],
    );
  });

  test('a private address is refused, including after a redirect', async () => {
    const f = fakeWeb({
      'https://example.com/go': {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/secret' },
      },
    });
    const web = createWebAccess({ settings: node.ctx.settings, fetchImpl: f, lookup: publicDns });
    await assert.rejects(web.page('http://10.0.0.5/x'), /private network/);
    await assert.rejects(web.page('https://example.com/go'), /private network/);
    assert.deepEqual(f.asked, ['https://example.com/go']);
    await assert.rejects(web.page('ftp://example.com/x'), /http/);
  });

  test('a picture or a PDF is not read as a page', async () => {
    const f = fakeWeb({
      'https://example.com/p.png': { body: PNG, headers: { 'content-type': 'image/png' } },
      'https://example.com/d.pdf': { body: 'x', headers: { 'content-type': 'application/pdf' } },
    });
    const web = createWebAccess({ settings: node.ctx.settings, fetchImpl: f, lookup: publicDns });
    await assert.rejects(web.page('https://example.com/p.png'), /download_image/);
    await assert.rejects(web.page('https://example.com/d.pdf'), /pdf/);
  });

  test('Brave search needs the key, then sends it and returns tidy results', async () => {
    const f = fakeWeb({
      'https://api.search.brave.com/res/v1/web/search?q=rice%20odisha&count=2': {
        body: JSON.stringify({
          web: { results: [{ title: 'T', url: 'https://a.example/', description: 'x <b>y</b>' }] },
        }),
        headers: { 'content-type': 'application/json' },
      },
    });
    let seenKey;
    const spy = async (u, o) => ((seenKey = o.headers['x-subscription-token']), f(u, o));
    const web = createWebAccess({ settings: node.ctx.settings, fetchImpl: spy, lookup: publicDns });
    await node.ctx.settings.update('research', { values: { search_engine: 'brave' } }, null);
    await assert.rejects(web.search('rice odisha', 2), /Settings → AI Research/);
    await node.ctx.settings.update('research', { values: { brave_api_key: 'k-test' } }, null);
    const r = await web.search('rice odisha', 2);
    assert.deepEqual(r, [{ title: 'T', url: 'https://a.example/', snippet: 'x y' }]);
    assert.equal(seenKey, 'k-test');
  });
});

describe('DuckDuckGo fallback', () => {
  const DDG = `<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Frice%3Fx%3D1&amp;rut=abc">Rice <b>guide</b></a></h2>
    <a class="result__snippet" href="x">Grown in <b>Odisha</b> &amp; more</a></div>
    <div class="result"><a class="result__a" href="javascript:alert(1)">Bad</a></div>`;
  const make = (body, status = 200) =>
    createWebAccess({
      settings: node.ctx.settings,
      lookup: publicDns,
      fetchImpl: fakeWeb({ 'https://html.duckduckgo.com/html/?q=rice': { body, status } }),
    });

  test('with no Brave key (automatic) it reads DuckDuckGo, unwraps the real address and skips junk', async () => {
    await node.ctx.settings.update(
      'research',
      { values: { search_engine: 'auto', brave_api_key: '' } },
      null,
    );
    const web = make(DDG);
    assert.equal(web.engine(), 'duckduckgo');
    assert.deepEqual(await web.search('rice'), [
      { title: 'Rice guide', url: 'https://a.example/rice?x=1', snippet: 'Grown in Odisha & more' },
    ]);
  });

  test('an empty or blocked answer is an error that says what to do, not an empty list', async () => {
    await assert.rejects(make('<html>captcha</html>').search('rice'), /another search engine/);
    await assert.rejects(make('x', 403).search('rice'), /403/);
  });

  test('a Brave key makes automatic prefer Brave', async () => {
    await node.ctx.settings.update('research', { values: { brave_api_key: 'k' } }, null);
    assert.equal(make(DDG).engine(), 'brave');
    await node.ctx.settings.update('research', { values: { brave_api_key: '' } }, null);
  });
});

describe('saving research and pictures', () => {
  const research = (table) =>
    createResearch(node.ctx, { fetch: fakeWeb(table), lookup: publicDns });

  test('research without a source link is refused; with one it is saved, listed and deleted over HTTP', async () => {
    const r = research({});
    await assert.rejects(r.create({ title: 'T', summary: 'S', sources: [] }), /source/i);
    await assert.rejects(
      r.create({ title: 'T', summary: 'S', sources: [{ url: 'javascript:alert(1)' }] }),
      /web address/i,
    );
    const item = await r.create(
      {
        title: 'Rice',
        topic: 'rice',
        summary: 'Grown in Odisha.',
        sources: [{ url: 'https://a.example/', title: 'A' }],
      },
      null,
    );
    const list = await admin.get('/api/admin/research');
    assert.equal(list.status, 200);
    assert.ok(
      list.body.items.some((i) => i.id === item.id && i.sources[0].url === 'https://a.example/'),
    );
    const one = await admin.get(`/api/admin/research/${item.id}`);
    assert.equal(one.body.item.summary, 'Grown in Odisha.');
    assert.equal((await admin.delete(`/api/admin/research/${item.id}`)).status, 204);
    assert.equal((await admin.get(`/api/admin/research/${item.id}`)).status, 404);
  });

  test('downloadImage stores a picture from another site in the media library with its credit', async () => {
    const r = research({
      'https://img.example/f.png': { body: PNG, headers: { 'content-type': 'image/png' } },
    });
    const { item, sourceUrl } = await r.downloadImage(
      { url: 'https://img.example/f.png', name: 'field', alt: 'A field', credit: 'Jo, CC BY 4.0' },
      null,
    );
    assert.equal(sourceUrl, 'https://img.example/f.png');
    assert.match(item.alt, /A field — Credit: Jo, CC BY 4\.0/);
    assert.ok((await node.ctx.media.get(item.id)).id);
  });

  test('something that is not a picture is rejected by the media library', async () => {
    const r = research({
      'https://img.example/x.png': {
        body: '<html>nope</html>',
        headers: { 'content-type': 'image/png' },
      },
    });
    await assert.rejects(r.downloadImage({ url: 'https://img.example/x.png' }, null), /JPEG, PNG/);
  });
});

describe('assistant tools', () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const run = async (calls, actor, web) => {
    const was = node.ctx.research;
    node.ctx.research = createResearch(node.ctx, { fetch: fakeWeb(web ?? {}), lookup: publicDns });
    try {
      const responses = [
        {
          content: calls.map((c, i) => ({
            type: 'tool_use',
            id: `t${i}`,
            name: c.name,
            input: c.input,
          })),
          stop_reason: 'tool_use',
          usage,
        },
        { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage },
      ];
      const seen = [];
      const client = {
        messages: {
          async create(req) {
            seen.push(req);
            return responses.shift();
          },
        },
      };
      const svc = createAssistant(node.ctx, { client });
      const s = await svc.create(actor);
      await svc.sendMessage(s.id, 'go', actor);
      return seen
        .at(-1)
        .messages.at(-1)
        .content.map((b) => ({ error: !!b.is_error, text: b.content }));
    } finally {
      node.ctx.research = was;
    }
  };
  const adm = { id: 1, email: 'a@example.com', can: () => true };
  const only = (...p) => ({ id: 2, email: 'b@example.com', can: (x) => p.includes(x) });

  test('fetch, download and save_research work end to end; the page comes back marked as untrusted', async () => {
    const out = await run(
      [
        { name: 'fetch_page', input: { url: 'https://example.com/post' } },
        {
          name: 'download_image',
          input: { url: 'https://example.com/a.png', name: 'a', credit: 'Ex' },
        },
        {
          name: 'save_research',
          input: {
            title: 'Rice',
            summary: 'Facts',
            sources: [{ url: 'https://example.com/post', title: 'Post' }],
          },
        },
      ],
      adm,
      {
        'https://example.com/post': { body: HTML, headers: { 'content-type': 'text/html' } },
        'https://example.com/a.png': { body: PNG, headers: { 'content-type': 'image/png' } },
      },
    );
    assert.ok(
      out.every((o) => !o.error),
      JSON.stringify(out),
    );
    assert.match(out[0].text, /untrustedWebContent/);
    assert.match(out[1].text, /"mediaId":\d+/);
    assert.match(out[2].text, /#\/research/);
    const saved = await node.ctx.research.list();
    assert.ok(saved.some((s) => s.title === 'Rice'));
  });

  test('without research.write nothing leaves the server', async () => {
    const out = await run(
      [{ name: 'fetch_page', input: { url: 'https://example.com/post' } }],
      only('pages.read'),
    );
    assert.equal(out[0].error, true);
    assert.match(out[0].text, /research\.write/);
  });

  test('find_in_admin answers with a menu link, and only for places the person may open', async () => {
    const [full] = await run(
      [{ name: 'find_in_admin', input: { query: 'how do I edit CSP headers' } }],
      adm,
    );
    const m = JSON.parse(full.text).matches;
    assert.match(m[0].link, /^\[Settings → Security\]\(#\/settings\/security(\/csp_[a-z_]+)?\)$/);
    const [limited] = await run(
      [{ name: 'find_in_admin', input: { query: 'csp headers' } }],
      only('admin.access'),
    );
    assert.deepEqual(JSON.parse(limited.text).matches, []);
  });
});

describe('the guide', () => {
  test('every screen it names is in the sidebar (and so is AI Research under Content)', () => {
    const app = fs.readFileSync(new URL('../admin/static/app.js', import.meta.url), 'utf8');
    for (const id of GUIDE_SCREEN_IDS)
      assert.ok(app.includes(`id: '${id}'`), `"${id}" is in the guide but not in the sidebar`);
    assert.match(app, /id: 'research', label: 'AI Research', module: 'research'/);
  });

  test('every link it hands out points at a real settings section or screen', async () => {
    const guide = createGuide({
      settings: node.ctx.settings,
      content: node.ctx.content,
      ctx: node.ctx,
    });
    const adm = { can: () => true };
    for (const q of ['csp', 'smtp email', 'research sources', 'cache', 'users', 'theme']) {
      const found = guide.find(adm, q, 10);
      assert.ok(found.length, q);
      for (const f of found) {
        const go = /\(#\/(.+)\)$/.exec(f.link)[1];
        if (go.startsWith('settings/')) {
          const [, ns, key] = go.split('/');
          assert.ok(node.ctx.settings.registry.has(ns), go);
          if (key) assert.ok(node.ctx.settings.registry.get(ns).fields[key], go);
        }
      }
    }
  });
});

describe('other search engines', () => {
  const answer = (url, body) => ({
    [url]: { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  });
  const set = (values) => node.ctx.settings.update('research', { values }, null);
  const web = (table, extra = {}) =>
    createWebAccess({
      settings: node.ctx.settings,
      fetchImpl: fakeWeb(table),
      lookup: publicDns,
      ...extra,
    });

  test('Tavily, Serper and Google each send their key and return the same tidy shape', async () => {
    const seen = [];
    const spy = (table) => async (u, o) => (seen.push({ u: String(u), o }), fakeWeb(table)(u, o));
    const mk = (table) =>
      createWebAccess({ settings: node.ctx.settings, fetchImpl: spy(table), lookup: publicDns });

    await set({ search_engine: 'tavily', tavily_api_key: 'tv' });
    let r = await mk(
      answer('https://api.tavily.com/search', {
        results: [{ title: 'A', url: 'https://a.example/', content: 'ca' }],
      }),
    ).search('q');
    assert.deepEqual(r, [{ title: 'A', url: 'https://a.example/', snippet: 'ca' }]);
    assert.equal(seen.at(-1).o.headers.authorization, 'Bearer tv');
    assert.equal(seen.at(-1).o.method, 'POST');

    await set({ search_engine: 'serper', serper_api_key: 'sp' });
    r = await mk(
      answer('https://google.serper.dev/search', {
        organic: [{ title: 'B', link: 'https://b.example/', snippet: 'sb' }],
      }),
    ).search('q');
    assert.equal(r[0].url, 'https://b.example/');
    assert.equal(seen.at(-1).o.headers['x-api-key'], 'sp');

    await set({ search_engine: 'google', google_api_key: 'gk', google_cx: 'cx1' });
    r = await mk(
      answer('https://www.googleapis.com/customsearch/v1?key=gk&cx=cx1&q=q&num=6', {
        items: [{ title: 'C', link: 'https://c.example/', snippet: 'sc' }],
      }),
    ).search('q');
    assert.equal(r[0].title, 'C');
    await set({ search_engine: 'google', google_cx: '' });
    await assert.rejects(mk({}).search('q'), /engine ID/);
  });

  test('SearXNG may sit on a private address, but only the one address that was configured', async () => {
    await set({ search_engine: 'searxng', searxng_url: 'http://10.1.2.3:8080' });
    const w = web({
      ...answer('http://10.1.2.3:8080/search?q=q&format=json', {
        results: [{ title: 'S', url: 'https://s.example/', content: 'x' }],
      }),
      'http://10.9.9.9/other': { body: 'x' },
    });
    assert.equal((await w.search('q'))[0].url, 'https://s.example/');
    await assert.rejects(w.page('http://10.1.2.3:8080/admin'), /private network/);
  });

  test('engines() says which are ready', async () => {
    await set({
      search_engine: 'auto',
      brave_api_key: '',
      tavily_api_key: '',
      serper_api_key: '',
      google_api_key: '',
      searxng_url: '',
    });
    const e = Object.fromEntries(
      web({})
        .engines()
        .map((x) => [x.id, x]),
    );
    assert.equal(e.duckduckgo.ready, true);
    assert.equal(e.duckduckgo.current, true);
    assert.equal(e.tavily.ready, false);
  });
});

describe('the Search screen API', () => {
  test('search, picture preview and import work over HTTP, and refuse what they should', async () => {
    await node.ctx.settings.update('research', { values: { search_engine: 'auto' } }, null);
    assert.equal((await admin.post('/api/admin/research/search').send({ query: 'x' })).status, 422);
    assert.equal((await admin.get('/api/admin/research/engines')).body.engines.length, 6);
    const note = await admin
      .post('/api/admin/research')
      .send({ title: 'N', topic: 'q', summary: 's', sources: [{ url: 'https://n.example/' }] });
    assert.equal(note.status, 201);
    // a private address never leaves the server, preview or import
    const t = await admin.get('/api/admin/research/thumb?url=http%3A%2F%2F127.0.0.1%2Fx.png');
    assert.equal(t.status, 422);
    const i = await admin
      .post('/api/admin/research/import-image')
      .send({ url: 'http://10.0.0.1/x.png' });
    assert.equal(i.status, 422);
  });
});
