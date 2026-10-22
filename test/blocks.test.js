import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { sanitizeBlocks, renderBlocks, blocksToText } from '../src/modules/content/blocks.js';

/** Everything an attacker might smuggle into inline text. */
const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="  jAvAsCrIpT:alert(1)">click</a>',
  '<a href="&#106;avascript:alert(1)">click</a>',
  '<a href="java\tscript:alert(1)">click</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
  '<a href="vbscript:msgbox(1)">click</a>',
  '<a href="//evil.example/x">protocol-relative</a>',
  '<svg onload=alert(1)><circle/></svg>',
  '<iframe src="https://evil.example"></iframe>',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<b onclick="alert(1)" style="x:expression(alert(1))">bold</b>',
  '<<script>script>alert(1)<</script>/script>',
  '<object data="x"></object><embed src="x"><form action="x"><input></form>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<div onmouseover="alert(1)">hover</div><p onclick=alert(1)>x</p>',
  '<a href="https://ok.example" onclick="alert(1)" target="_blank">ok</a>',
  '"><script>alert(1)</script>',
];

function assertHarmless(html, label) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  for (const bad of [
    'script',
    'iframe',
    'style',
    'svg',
    'object',
    'embed',
    'form',
    'input',
    'meta',
    'math',
    'link',
    'base',
  ])
    assert.equal(doc.querySelectorAll(bad).length, 0, `${label}: <${bad}> survived`);
  for (const el of doc.querySelectorAll('*')) {
    for (const a of el.attributes) {
      assert.ok(!/^on/i.test(a.name), `${label}: ${a.name} survived on <${el.tagName}>`);
      assert.notEqual(a.name, 'style', `${label}: style survived`);
      if (['href', 'src'].includes(a.name)) {
        const v = [...a.value]
          .filter((c) => c.charCodeAt(0) > 32)
          .join('')
          .toLowerCase();
        assert.ok(
          !/^(javascript|vbscript|data):/.test(v),
          `${label}: dangerous ${a.name}="${a.value}"`,
        );
        assert.ok(!v.startsWith('//'), `${label}: protocol-relative ${a.name}`);
      }
    }
  }
}

test('crafted inline text cannot produce script, handlers or dangerous links, in any text-bearing block', () => {
  for (const [i, p] of PAYLOADS.entries()) {
    const doc = sanitizeBlocks({
      blocks: [
        { type: 'paragraph', data: { text: p } },
        { type: 'header', data: { text: p, level: 2 } },
        { type: 'list', data: { style: 'unordered', items: [p, `x ${p}`] } },
        { type: 'quote', data: { text: p, caption: p } },
        { type: 'code', data: { code: p } },
        { type: 'image', data: { mediaId: 1, caption: p, alt: p } },
      ],
    });
    const images = new Map([
      [
        1,
        {
          src: '/media/1/original.jpg',
          srcset: '/media/1/320.webp 320w',
          width: 10,
          height: 10,
          alt: 'a"b',
        },
      ],
    ]);
    assertHarmless(renderBlocks(doc, { images }), `payload ${i}`);
    // …and the stored JSON itself carries no raw script either, so nothing downstream (search, API) has to be careful.
    const stored = JSON.stringify(doc.blocks.filter((b) => b.type !== 'code'));
    assert.ok(
      !/<script|onerror=|onclick=|javascript:/i.test(stored),
      `payload ${i} stored as ${stored.slice(0, 120)}`,
    );
  }
});

test('rendering is safe by itself: a hostile document that skipped sanitising still cannot inject markup', () => {
  const hostile = {
    blocks: [
      {
        type: 'paragraph',
        data: { text: '<img src=x onerror=alert(1)><script>alert(1)</script>' },
      },
      {
        type: 'header',
        data: { text: '<script>alert(1)</script>', level: '2><script>alert(1)</script>' },
      },
      {
        type: 'list',
        data: { style: 'unordered"><script>', items: ['<script>alert(1)</script>'] },
      },
      { type: 'code', data: { code: '</code></pre><script>alert(1)</script>' } },
      {
        type: 'image',
        data: { mediaId: 1, alt: '" onerror="alert(1)', caption: '<script>alert(1)</script>' },
      },
      { type: 'made-up', data: { html: '<script>alert(1)</script>' } },
    ],
  };
  const images = new Map([
    [
      1,
      {
        src: '/media/1/x.jpg" onerror="alert(1)',
        srcset: 'a" onerror="alert(1) 1w',
        width: 5,
        height: 5,
        alt: '"><script>',
      },
    ],
  ]);
  assertHarmless(renderBlocks(hostile, { images }), 'hostile');
});

test('safe formatting and links survive, and outbound links are marked', () => {
  const doc = sanitizeBlocks({
    blocks: [
      {
        type: 'paragraph',
        data: {
          text: 'A <b>bold</b>, <i>italic</i> and <a href="https://example.com/x?a=1&b=2" target="_blank">link</a><br>next <a href="mailto:a@b.co">mail</a> <a href="tel:+911234">call</a>',
        },
      },
    ],
  });
  const html = renderBlocks(doc);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<i>italic<\/i>/);
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2" rel="noopener nofollow ugc">link<\/a>/,
  );
  assert.doesNotMatch(html, /target=/);
  assert.match(html, /href="mailto:a@b\.co"/);
  assert.match(html, /href="tel:\+911234"/);
  assert.match(html, /<br \/>|<br>/);
});

test('structure is validated: unknown block types, wrong shapes and oversize documents are refused with a clear message', () => {
  const bad = (doc, re) =>
    assert.throws(
      () => sanitizeBlocks(doc),
      (e) => e.status === 422 && re.test(e.message),
    );
  bad(
    { blocks: [{ type: 'raw', data: { html: '<b>' } }] },
    /Block 1: "raw" isn't a supported block type/,
  );
  bad({ blocks: [{ type: 'paragraph', data: { text: 'ok' } }, { data: {} }] }, /Block 2/);
  bad({ blocks: [{ type: 'image', data: { mediaId: 'abc' } }] }, /Block 1/);
  bad({ blocks: [{ type: 'image', data: { mediaId: -4 } }] }, /Block 1/);
  bad({ blocks: [{ type: 'header', data: { text: 'x', level: 9 } }] }, /Block 1/);
  bad({ blocks: [{ type: 'paragraph', data: { text: 'x'.repeat(20001) } }] }, /Block 1/);
  bad({ notBlocks: 1 }, /list of blocks/);
  bad('{not json', /valid JSON/);
  bad(
    { blocks: Array.from({ length: 1001 }, () => ({ type: 'delimiter', data: {} })) },
    /Too many blocks/,
  );
  bad(
    {
      blocks: Array.from({ length: 400 }, () => ({
        type: 'paragraph',
        data: { text: 'y'.repeat(4000) },
      })),
    },
    /too large/,
  );
  assert.deepEqual(sanitizeBlocks('').blocks, []);
  assert.deepEqual(sanitizeBlocks(null).blocks, []);
});

test('plain text extraction (for search) skips code and markup', () => {
  const doc = sanitizeBlocks({
    blocks: [
      { type: 'header', data: { text: 'Title & more', level: 1 } },
      { type: 'paragraph', data: { text: 'Some <b>bold</b> words' } },
      { type: 'code', data: { code: 'secret_code()' } },
      { type: 'list', data: { style: 'ordered', items: ['one', 'two <i>2</i>'] } },
    ],
  });
  const text = blocksToText(doc);
  assert.match(text, /Title & more/);
  assert.match(text, /Some bold words/);
  assert.match(text, /one two 2/);
  assert.doesNotMatch(text, /secret_code|<b>/);
});

test('lines typed in a paragraph keep their breaks, and blank lines stay blank', () => {
  const text = (t) =>
    sanitizeBlocks({ blocks: [{ type: 'paragraph', data: { text: t } }] }).blocks[0].data.text;
  assert.equal(text('one<div>two</div>'), 'one<br />two');
  assert.equal(text('a<div><br></div><div>b</div>'), 'a<br /><br />b');
  assert.equal(text('<p>first</p><p>second</p>'), 'first<br />second');
});

test('internal links survive without nofollow; external links keep it', () => {
  const html = sanitizeBlocks({
    blocks: [
      {
        type: 'paragraph',
        data: {
          text: '<a href="/about">a</a> <a href="#faq">b</a> <a href="https://x.example">c</a>',
        },
      },
    ],
  }).blocks[0].data.text;
  assert.match(html, /<a href="\/about">a<\/a>/);
  assert.match(html, /<a href="#faq">b<\/a>/);
  assert.match(html, /<a href="https:\/\/x\.example" rel="noopener nofollow ugc">c<\/a>/);
});
