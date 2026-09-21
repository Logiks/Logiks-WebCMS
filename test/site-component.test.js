import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SiteFormatError,
  compileComponent,
  parseComponent,
  parsePage,
  scopeCss,
  scopeIdsIn,
  splitFrontMatter,
} from '../src/modules/site/component.js';

const S = '[data-c="x"]';
const fails = (fn, re) =>
  assert.throws(fn, (e) => e instanceof SiteFormatError && re.test(e.message));

describe('page front matter', () => {
  test('reads strings, numbers and booleans, and leaves the body alone', () => {
    const { front, body } = splitFrontMatter(
      '---\ntitle: About us\ncolumns: 3\nnoindex: true\nsubtitle: "Hi: there"\n# a comment\n---\n<p>Hello</p>',
    );
    assert.deepEqual(front, {
      title: 'About us',
      columns: 3,
      noindex: true,
      subtitle: 'Hi: there',
    });
    assert.equal(body, '<p>Hello</p>');
  });

  test('a page without front matter is just a body', () => {
    assert.deepEqual(splitFrontMatter('<p>x</p>'), { front: {}, body: '<p>x</p>' });
  });

  test('a bad line names its number', () => {
    fails(() => splitFrontMatter('---\ntitle: ok\nnot a pair\n---\nx'), /line 2/);
  });

  test('known keys are checked; unknown scalar keys pass through for themes to read', () => {
    const { front } = parsePage('---\ntitle: T\nlayout: landing\nhero_image: /media/a.jpg\n---\nx');
    assert.equal(parsePage('---\nentry: post\n---\nx').front.entry, 'post');
    assert.equal(parsePage('---\nentry: page:about/team\n---\nx').front.entry, 'page:about/team');
    assert.equal(
      parsePage('---\nentry: own\nterms: category\nlimit: search\ncache: false\n---\nx').front
        .limit,
      'search',
    );
    fails(() => parsePage('---\nentry: Post\n---\nx'), /entry/);
    fails(() => parsePage('---\nlimit: everything\n---\nx'), /limit/);
    assert.equal(front.layout, 'landing');
    assert.equal(front.hero_image, '/media/a.jpg');
    fails(() => parsePage('---\nlayout: ../etc\n---\nx'), /layout/);
    fails(() => parsePage('---\nnoindex: maybe\n---\nx'), /noindex/);
  });

  test('scripts are refused for now', () => {
    fails(() => parsePage('<p>x</p><script>alert(1)</script>'), /<script>/);
    fails(() => parsePage('<SCRIPT src=x></SCRIPT>'), /<script>/);
  });
});

describe('component files', () => {
  const SRC = `<script type="application/json" data-cms="meta">
    {"title":"Hero","props":{"heading":{"type":"string","default":"Hi"}},"api":[{"name":"posts","url":"/api/public/posts?limit=3"}]}
  </script>
  <style>.title { color: red } </style>
  <section class="title">{{ heading }}</section>`;

  test('splits meta, css and template', () => {
    const c = parseComponent(SRC);
    assert.equal(c.meta.title, 'Hero');
    assert.equal(c.meta.api[0].method, 'GET');
    assert.equal(c.meta.api[0].required, false);
    assert.equal(c.css, '.title { color: red }');
    assert.equal(c.template, '<section class="title">{{ heading }}</section>');
  });

  test('meta and style are optional', () => {
    const c = parseComponent('<p>x</p>');
    assert.deepEqual([c.css, c.template, c.meta.api], ['', '<p>x</p>', []]);
  });

  test('meta problems are explained', () => {
    const wrap = (j) => `<script type="application/json" data-cms="meta">${j}</script><p>x</p>`;
    fails(() => parseComponent(wrap('{oops')), /not valid JSON/);
    fails(() => parseComponent(wrap('{"colour":"red"}')), /Meta/);
    fails(
      () => parseComponent(wrap('{"api":[{"name":"a","url":"https://evil.example/x"}]}')),
      /\/api\/public\//,
    );
    fails(
      () => parseComponent(wrap('{"api":[{"name":"A b","url":"/api/public/x"}]}')),
      /api names/,
    );
    fails(() => parseComponent(wrap('{}') + wrap('{}')), /only one meta/);
    // an address can use Liquid; only the prefix is checked when saving
    parseComponent(
      wrap(
        '{"api":[{"name":"p","url":"/api/public/content/post/{{ slug | url_encode }}","required":true}]}',
      ),
    );
  });

  test('scripts and unclosed styles are refused', () => {
    fails(() => parseComponent('<p>x</p><script>1</script>'), /<script>/);
    fails(() => parseComponent('<style>.a{color:red}<p>x</p>'), /not closed/);
  });

  test('CSS that could load or run something is refused', () => {
    for (const bad of [
      '@import url(https://evil.example/x.css);',
      '.a{width:expression(alert(1))}',
      '.a{background:url(javascript:alert(1))}',
      '.a{background:url("data:text/html,<b>")}',
      '.a{content:"<!--"}',
    ])
      fails(
        () => parseComponent(`<style>${bad}</style><p>x</p>`),
        /CSS|@import|url\(\)|markup|not closed/,
      );
    fails(() => parseComponent('<style>.a{}</style></style><p>x</p>'), /stray/);
    parseComponent('<style>.a{background:url(data:image/png;base64,AAAA)}</style><p>x</p>'); // images are fine
  });
});

describe('scoped CSS', () => {
  test('every selector is confined to the component', () => {
    assert.equal(scopeCss('.a{color:red}', S), `${S} .a{color:red}`);
    assert.equal(scopeCss('h1, .b > p:hover{x:y}', S), `${S} h1,${S} .b > p:hover{x:y}`);
    assert.equal(scopeCss('a:not(.x, .y), b{x:y}', S), `${S} a:not(.x, .y),${S} b{x:y}`);
  });

  test(':host is the wrapper itself', () => {
    assert.equal(scopeCss(':host{display:block}', S), `${S}{display:block}`);
    assert.equal(scopeCss(':host(.wide) p{x:y}', S), `${S}.wide p{x:y}`);
  });

  test('media queries are rewritten inside; keyframes and font-face are not', () => {
    assert.equal(
      scopeCss('@media (min-width:600px){.a{x:y}.b{z:1}}', S),
      `@media (min-width:600px){${S} .a{x:y}${S} .b{z:1}}`,
    );
    assert.equal(
      scopeCss('@keyframes spin{from{a:b}to{a:c}}', S),
      '@keyframes spin{from{a:b}to{a:c}}',
    );
    assert.equal(
      scopeCss('@font-face{font-family:X;src:url(a.woff2)}', S),
      '@font-face{font-family:X;src:url(a.woff2)}',
    );
  });

  test('comments, braces in strings and native nesting are handled', () => {
    assert.equal(scopeCss('/* hi */ .a::after{content:"}{"}', S), `${S} .a::after{content:"}{"}`);
    assert.equal(
      scopeCss('.a{color:red; &:hover{color:blue}}', S),
      `${S} .a{color:red; &:hover{color:blue}}`,
    );
  });

  test('malformed CSS is reported, not passed through', () => {
    fails(() => scopeCss('.a{color:red', S), /unclosed/);
    fails(() => scopeCss('color:red;', S), /top level|outside any rule/);
    fails(() => scopeCss('.a{}\nstray', S), /outside any rule/);
  });
});

describe('compiled components', () => {
  test('a component with endpoints starts with the tag that loads them', () => {
    const c = compileComponent(
      'site:x',
      '<script type="application/json" data-cms="meta">{"api":[{"name":"posts","url":"/api/public/content/post"}]}</script><p>{{ api.posts.total }}</p>',
    );
    assert.match(c.template, new RegExp(`^<div data-c="${c.id}">{% cms_api "${c.id}" %}<p>`));
    assert.equal(c.apis[0].name, 'posts');
    assert.ok(!compileComponent('site:y', '<p>x</p>').template.includes('cms_api'));
  });

  test('the template is wrapped with a scope id that follows the css', () => {
    const a = compileComponent('site:hero', '<style>.t{color:red}</style><h1 class="t">x</h1>');
    const b = compileComponent('site:hero', '<style>.t{color:blue}</style><h1 class="t">x</h1>');
    const c = compileComponent('site:other', '<style>.t{color:red}</style><h1 class="t">x</h1>');
    assert.match(a.id, /^[a-f0-9]{8}$/);
    assert.notEqual(a.id, b.id, 'changing the css changes the id');
    assert.notEqual(a.id, c.id, 'same css in another component gets its own id');
    assert.equal(a.template, `<div data-c="${a.id}"><h1 class="t">x</h1></div>`);
    assert.equal(a.css, `[data-c="${a.id}"] .t{color:red}`);
  });

  test('scope ids are found in rendered html, once each, in order', () => {
    assert.deepEqual(
      scopeIdsIn('<div data-c="aaaaaaaa"><i data-c="bbbbbbbb"></i></div><b data-c="aaaaaaaa"></b>'),
      ['aaaaaaaa', 'bbbbbbbb'],
    );
    assert.deepEqual(scopeIdsIn('<p data-c="short">'), []);
  });
});
