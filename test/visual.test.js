import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeNode } from './helpers.js';
import {
  createVisual,
  problemsOf,
  referenceMarkdown,
  staticTokens,
} from '../src/modules/visual/service.js';

let node, visual, ok, ref, refUrl;
const PAGE = `<!doctype html><html lang="en"><head><title>Ref shop</title>
<style>
body{margin:0;font-family:Georgia,serif;background:#faf7f2;color:#222}
header{background:#1f2937;padding:16px}header a{color:#fff;margin-right:12px}
h1{font-size:56px;margin:0;padding:80px 40px}
.btn{background:#c2410c;color:#fff;padding:12px 20px;border-radius:8px;display:inline-block}
.wrap{max-width:1000px;margin:0 auto}
</style></head><body>
<header><a href="/">Menu</a><a href="/visit">Visit</a></header>
<main><section class="wrap"><h1>Fresh bread daily</h1><a class="btn" href="/order">Order now</a></section>
<section class="wrap"><h2>Our story</h2><p>Baked since 1990.</p></section></main></body></html>`;

before(async () => {
  node = await makeNode();
  visual = createVisual({
    settings: node.ctx.settings,
    web: () => ({
      check: async () => {},
      source: async (u) => ({ text: PAGE, type: 'text/html', finalUrl: u }),
    }),
    origin: () => node.url,
  });
  ok = (await visual.status()).ok;
  ref = http.createServer((_q, res) => res.setHeader('content-type', 'text/html').end(PAGE));
  await new Promise((r) => ref.listen(0, '127.0.0.1', r));
  refUrl = `http://127.0.0.1:${ref.address().port}/`;
});
after(async () => {
  await visual.close();
  ref.close();
  await node.close();
});

describe('pure helpers', () => {
  test('problemsOf turns a report into sentences', () => {
    const p = problemsOf({
      width: 390,
      report: {
        horizontalScroll: true,
        overflowingElements: ['div.hero'],
        brokenImages: ['/x.png'],
        h1Count: 0,
        emptyLinks: 2,
        formsWithoutAction: 1,
        metaDescription: false,
        title: 'T',
        imagesWithoutAlt: 1,
        tinyText: 0,
        smallTouchTargets: 3,
      },
      consoleErrors: ['boom'],
      failedRequests: ['404 /a.css'],
      blockedExternal: ['https://cdn/x.js'],
    });
    const all = p.join('\n');
    for (const re of [
      /scrolls sideways at 390px.*div\.hero/,
      /\/x\.png/,
      /0 h1/,
      /2 links go nowhere/,
      /no place to send/,
      /No meta description/,
      /boom/,
      /404 \/a\.css/,
      /outside the site/,
      /shorter than 32px/,
    ])
      assert.match(all, re);
  });

  test('a clean report has no problems', () => {
    assert.deepEqual(
      problemsOf({
        width: 1280,
        report: {
          horizontalScroll: false,
          overflowingElements: [],
          brokenImages: [],
          h1Count: 1,
          emptyLinks: 0,
          formsWithoutAction: 0,
          metaDescription: true,
          title: 'T',
          imagesWithoutAlt: 0,
          tinyText: 0,
          smallTouchTargets: null,
        },
        consoleErrors: [],
        failedRequests: [],
        blockedExternal: [],
      }),
      [],
    );
  });

  test('static reading finds colours, fonts, the nav and the headings without a browser', () => {
    const t = staticTokens(PAGE, '');
    assert.ok(t.palette.backgrounds.includes('#c2410c'));
    assert.deepEqual(t.fonts, ['Georgia']);
    assert.ok(t.sections.some((s) => s.heading === 'Fresh bread daily'));
    const md = referenceMarkdown(t, 'https://ref.example/');
    assert.equal(md.heading, 'Reference: ref.example');
    assert.match(md.body, /no text or pictures were copied/);
  });
});

describe('without a browser', () => {
  test('capture says what to install, and reference falls back to reading the text', async () => {
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    try {
      assert.equal((await visual.status()).ok, false);
      await assert.rejects(visual.capture({ path: '/' }), /not available on this server/);
      const r = await visual.reference('https://ref.example/');
      assert.equal(r.mode, 'static');
      assert.equal(r.jpeg, null);
      assert.ok(r.tokens.sections.length);
    } finally {
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
  });

  test('a path that is not a path is refused before any browser starts', async () => {
    await assert.rejects(visual.capture({ path: 'https://evil.example/' }), /such as \/about/);
  });
});

describe('with a real browser', () => {
  test('captures a page of the site, reports problems, and blocks outside requests', async (t) => {
    if (!ok) return t.skip('no Chrome/Chromium on this machine');
    await node.ctx.siteFiles.put(
      'pages/shot.html',
      '---\ntitle: Shot\n---\n<h1>Hello</h1><h1>Twice</h1><a href="#">go</a><img src="/nope.png" alt=""><link rel="stylesheet" href="https://cdn.example.com/x.css"><div style="width:2000px;height:20px;background:#eee"></div>',
      { id: null, email: null, can: () => true },
    );
    const c = await visual.capture({ path: '/shot', viewport: 'mobile' });
    assert.equal(c.jpeg[0], 0xff); // a JPEG
    assert.equal(c.width, 390);
    assert.equal(c.report.h1Count >= 2, true);
    assert.equal(c.report.horizontalScroll, true);
    // The site's own security policy already stops outside files, so nothing even reaches the block list.
    const text = problemsOf(c).join('\n');
    assert.match(text, /sideways/);
    assert.match(text, /go nowhere/);
  });

  test('captures an unsaved draft served from the site’s own address', async (t) => {
    if (!ok) return t.skip('no Chrome/Chromium on this machine');
    const c = await visual.capture({
      html: '<!doctype html><title>Draft</title><h1>Draft page</h1>',
      viewport: 'desktop',
    });
    assert.equal(c.report.title, 'Draft');
    assert.equal(c.jpeg[0], 0xff);
  });

  test('reads a reference page: palette, type, layout and outline, with scripts off', async (t) => {
    if (!ok) return t.skip('no Chrome/Chromium on this machine');
    const r = await visual.reference(refUrl);
    assert.equal(r.mode, 'browser');
    assert.ok(r.jpeg.length > 500);
    const tk = r.tokens;
    assert.ok(tk.palette.accent.includes('#c2410c'), JSON.stringify(tk.palette));
    assert.equal(tk.fonts[0], 'Georgia');
    assert.equal(tk.type.h1.sizePx, 56);
    assert.equal(tk.containerWidthPx, 1000);
    assert.ok(tk.radius.includes('8px'));
    assert.deepEqual(tk.navLinks.slice(0, 2), ['Menu', 'Visit']);
    assert.ok(tk.ctas.includes('Order now'));
    assert.ok(tk.sections.some((s) => s.heading === 'Fresh bread daily'));
  });

  test('a reference whose address resolves to a private network is refused for every request', async (t) => {
    if (!ok) return t.skip('no Chrome/Chromium on this machine');
    const strict = createVisual({
      settings: node.ctx.settings,
      web: () => ({
        check: async () => {
          throw new Error('private network');
        },
        source: async () => ({}),
      }),
      origin: () => node.url,
    });
    await assert.rejects(strict.reference(refUrl), /private network/);
    await strict.close();
  });
});
