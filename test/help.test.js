import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { createHelp, parseFront } from '../src/modules/help/service.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

/** A throwaway docs folder: { 'help/a.md': text } → <tmp>/docs/help/a.md, and a Help service reading it. */
function helpFor(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, 'docs', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return { help: createHelp({ appRoot: root }), root };
}
const doc = (front, body) => `---\n${front}\n---\n${body}`;

describe('the shipped docs drive Help', () => {
  test('every guide and prompt in docs/ is well formed and its links resolve', () => {
    assert.deepEqual(node.ctx.help.problems(), []);
  });

  test('the four sections are filled, and the library has a good number of prompts', async () => {
    const r = await admin.get('/api/admin/help');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.sections.map((s) => s.id),
      ['administration', 'support', 'coding', 'ai'],
    );
    for (const s of r.body.sections) assert.ok(s.docs.length >= 3, `${s.id} has guides`);
    assert.ok(r.body.promptCount >= 20, `prompts: ${r.body.promptCount}`);
    const coding = r.body.sections.find((s) => s.id === 'coding').docs.map((d) => d.slug);
    for (const want of ['liquid-guide', 'getting-data-into-pages', 'site-structure'])
      assert.ok(coding.includes(want), want);
  });

  test('every listed guide renders, with a table of contents and no leftover raw HTML tags', async () => {
    const idx = (await admin.get('/api/admin/help')).body;
    for (const s of idx.sections)
      for (const d of s.docs) {
        const r = await admin.get(`/api/admin/help/${s.id}/${d.slug}`);
        assert.equal(r.status, 200, `${s.id}/${d.slug}`);
        assert.ok(r.body.doc.html.length > 200, `${s.id}/${d.slug} has text`);
        assert.doesNotMatch(r.body.doc.html, /<script|<iframe|\son\w+=/i, `${s.id}/${d.slug}`);
        // Every link we produce stays inside Help or goes to an https address.
        for (const m of r.body.doc.html.matchAll(/<a href="([^"]+)"/g))
          assert.match(m[1], /^(#\/help\/[a-z-]+(\/[a-z0-9-]+)?|https?:\/\/.+)$/, m[1]);
      }
  });

  test('the doc order and neighbours are given for next/previous links', async () => {
    const r = (await admin.get('/api/admin/help/administration/getting-started')).body.doc;
    assert.equal(r.previous, null);
    assert.ok(r.next && r.next.section === 'administration');
  });

  test('the prompt library: categories, blanks and no half-open blanks', async () => {
    const r = await admin.get('/api/admin/help/prompts');
    assert.equal(r.status, 200);
    assert.ok(r.body.categories.length >= 8);
    const brief = r.body.items.find((i) => i.id === 'site-brief');
    assert.ok(brief.blanks.includes('Audience'));
    for (const p of r.body.items) {
      assert.ok(p.body.length > 80, p.id);
      assert.ok(p.category, p.id);
      const open = (p.body.match(/\[\[/g) ?? []).length;
      const closed = (p.body.match(/\]\]/g) ?? []).length;
      assert.equal(open, closed, `${p.id}: unbalanced [[ ]]`);
      const found = [...p.body.matchAll(/\[\[([^\][\n]{1,60})\]\]/g)].length;
      assert.equal(found, open, `${p.id}: a blank is too long or spans lines`);
    }
  });

  test('search finds a guide by a word in its text, best matches first', async () => {
    const r = await admin.get('/api/admin/help/search?q=webhook signature');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length >= 1);
    assert.ok(r.body.items.some((i) => i.slug === 'automation'));
    assert.deepEqual((await admin.get('/api/admin/help/search?q=x')).body.items, []);
    assert.deepEqual((await admin.get('/api/admin/help/search?q=zzqqxxnotaword')).body.items, []);
  });
});

describe('support guides', () => {
  test('the FAQ is an accordion of its questions; symptom tables carry column labels for phones', async () => {
    const faq = (await admin.get('/api/admin/help/support/faq')).body.doc;
    assert.equal(faq.layout, 'accordion');
    const qa = [...faq.html.matchAll(/<details class="help-qa"><summary>([^<]+\?)<\/summary><p>/g)];
    assert.ok(qa.length >= 15, `questions: ${qa.length}`);
    assert.doesNotMatch(
      faq.html,
      /<p><strong>[^<]*\?<\/strong>/,
      'no question left as a plain paragraph',
    );
    const tr = (await admin.get('/api/admin/help/support/troubleshooting')).body.doc;
    assert.equal(tr.layout, 'lookup');
    assert.match(tr.html, /<td data-label="Symptom">/);
    assert.ok(tr.icon.startsWith('bi-'));
  });

  test('search can be limited to the Support guides', async () => {
    const all = (await admin.get('/api/admin/help/search?q=webhook')).body.items;
    const sup = (await admin.get('/api/admin/help/search?q=email&section=support')).body.items;
    assert.ok(all.some((i) => i.section !== 'support'));
    assert.ok(sup.length >= 1 && sup.every((i) => i.section === 'support'));
  });

  test('an unknown layout or icon in front matter is ignored, not trusted', () => {
    const { help } = helpFor({
      'a.md': doc('section: support\ntitle: A\nsummary: S\nlayout: weird\nicon: "><script>"', 'x'),
    });
    const d = help.get('support', 'a');
    assert.equal(d.layout, '');
    assert.equal(d.icon, '');
  });
});

describe('access and bad input', () => {
  test('Help needs a signed-in admin', async () => {
    const r = await fetch(`${node.url}/api/admin/help`);
    assert.equal(r.status, 401);
    const g = await fetch(`${node.url}/api/admin/help/administration/getting-started`);
    assert.equal(g.status, 401);
  });

  test('an unknown guide, a bad name and the prompt section are all 404s, not errors', async () => {
    for (const p of [
      '/administration/nope',
      '/nope/getting-started',
      '/administration/..%2F..%2Fpackage',
      '/administration/Getting-Started',
      '/prompts/site-brief',
    ])
      assert.equal((await admin.get(`/api/admin/help${p}`)).status, 404, p);
  });
});

describe('how a doc becomes a page of Help', () => {
  test('front matter is read, and files with no section stay out', () => {
    const { help } = helpFor({
      'help/a.md': doc(
        'section: coding\ntitle: Alpha: first\nsummary: S\norder: 5',
        '# Alpha\n\nText',
      ),
      'NOTES.md': '# Developer notes\nNot for Help.',
    });
    const idx = help.index();
    assert.deepEqual(idx.sections.find((s) => s.id === 'coding').docs, [
      { slug: 'a', section: 'coding', title: 'Alpha: first', summary: 'S', icon: '' },
    ]);
    assert.equal(
      idx.sections.reduce((n, s) => n + s.docs.length, 0),
      1,
    );
    assert.deepEqual(parseFront('no front matter').front, {});
  });

  test('raw HTML in a guide is shown as text, never run', () => {
    const { help } = helpFor({
      'a.md': doc(
        'section: support\ntitle: A\nsummary: S',
        '# A\n\n<script>alert(1)</script>\n\nInline <img src=x onerror=alert(1)> here.\n\n[bad](javascript:alert(1)) and ![pic](http://x/y.png)',
      ),
    });
    const html = help.get('support', 'a').html;
    assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
    assert.match(html, /&lt;script&gt;/);
  });

  test('links between guides become Help links, outside links open safely, anything else is plain text', () => {
    const { help } = helpFor({
      'help/one.md': doc(
        'section: ai\ntitle: One\nsummary: S',
        '[two](two.md#x) [ext](https://example.com) [src](../src/app.js) [lib](#/help/prompts)',
      ),
      'help/two.md': doc('section: ai\ntitle: Two\nsummary: S', 'x'),
    });
    const html = help.get('ai', 'one').html;
    assert.match(html, /<a href="#\/help\/ai\/two">two<\/a>/);
    assert.match(
      html,
      /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ext<\/a>/,
    );
    assert.match(html, /<a href="#\/help\/prompts">lib<\/a>/);
    assert.doesNotMatch(html, /src\/app\.js/);
  });

  test('problems() names a broken link, a missing title and a duplicate', () => {
    const { help } = helpFor({
      'a/same.md': doc('section: ai\ntitle: A\nsummary: S', '[gone](missing.md)'),
      'b/same.md': doc('section: ai\ntitle: B\nsummary: S', 'x'),
      'c.md': doc('section: nowhere\nsummary: S', 'x'),
      'd.md': doc('section: prompts\ntitle: D\nsummary: S', 'a prompt with no category'),
    });
    const p = help.problems().join('\n');
    assert.match(p, /goes nowhere/);
    assert.match(p, /used by another file/);
    assert.match(p, /unknown section "nowhere"/);
    assert.match(p, /no title/);
    assert.match(p, /needs a category/);
  });

  test('a changed file is picked up without a restart', async () => {
    const { help, root } = helpFor({ 'a.md': doc('section: ai\ntitle: A\nsummary: S', 'first') });
    assert.match(help.get('ai', 'a').html, /first/);
    const file = path.join(root, 'docs', 'a.md');
    fs.writeFileSync(file, doc('section: ai\ntitle: A\nsummary: S', 'second, longer text'));
    assert.match(help.get('ai', 'a').html, /second, longer text/);
    fs.unlinkSync(file);
    assert.throws(() => help.get('ai', 'a'), /not found/i);
  });
});

describe('admin screens are never served from a stale browser cache', () => {
  test('the SPA files and every module fragment must be revalidated, and answer 304 when unchanged', async () => {
    for (const p of [
      '/admin/static/app.js',
      '/admin/static/admin-ui.css',
      '/admin/modules/site/components-list.html',
      '/admin/modules/site/template-picker.html',
      '/admin/modules/help/page.html',
    ]) {
      const r = await fetch(`${node.url}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('cache-control') ?? '', /no-cache/, p);
      assert.doesNotMatch(r.headers.get('cache-control') ?? '', /immutable|max-age=[1-9]/, p);
      const again = await fetch(`${node.url}${p}`, {
        // A browser revalidating sends max-age=0 (Node's fetch would send no-cache here, which forces a full 200).
        headers: { 'if-none-match': r.headers.get('etag') ?? '', 'cache-control': 'max-age=0' },
      });
      assert.equal(again.status, 304, p);
    }
  });
});
