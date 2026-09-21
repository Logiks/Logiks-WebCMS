import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { flatten, makeTranslator, nest, siteLocales } from '../src/modules/site/i18n.js';

const zipOf = (files) => {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  return z.toBuffer();
};

describe('merging languages (pure)', () => {
  test('keys nest and flatten both ways', () => {
    const nested = { blog: { older: 'Older', more: { x: 'X' } }, top: 'T' };
    assert.deepEqual(flatten(nested), { 'blog.older': 'Older', 'blog.more.x': 'X', top: 'T' });
    assert.deepEqual(nest(flatten(nested)), nested);
  });

  test('edited beats shipped beats theme; then base language, default language, English, the fallback text, the key', () => {
    const t = makeTranslator({
      layers: [
        { en: { a: 'site en' }, fr: { a: 'site fr' } },
        { fr: { a: 'shipped fr', s: 'shipped fr s' } },
        {
          en: { a: 'theme en', b: 'theme en b' },
          fr: { b: 'theme fr b', s: 'theme fr s' },
          hi: { c: 'theme hi c' },
        },
      ],
      defaultLocale: 'en',
    });
    assert.equal(t('fr', 's'), 'shipped fr s', 'the shipped wording beats the theme’s');
    assert.equal(t('fr', 'a'), 'site fr', 'site beats theme');
    assert.equal(t('fr', 'b'), 'theme fr b', 'the theme fills what the site does not say');
    assert.equal(t('fr-CA', 'a'), 'site fr', 'a regional code uses its base language');
    assert.equal(t('de', 'a'), 'site en', 'an unknown language falls back to the default language');
    assert.equal(t('hi', 'a'), 'site en');
    assert.equal(t('hi', 'c'), 'theme hi c');
    assert.equal(t('fr', 'nope', 'Fallback text'), 'Fallback text');
    assert.equal(t('fr', 'nope'), 'nope');
    assert.equal(t('fr', 'blog'), 'blog', 'a branch is not a string');
  });

  test('a language file with broken JSON is skipped, not fatal', () => {
    const files = new Map([
      ['locales/en.json', { content: '{"a":"A"}' }],
      ['locales/fr.json', { content: '{oops' }],
      ['pages/x.html', { content: 'x' }],
    ]);
    assert.deepEqual(siteLocales(files), { en: { a: 'A' } });
  });
});

let node, admin;
const get = (p) => request(node.app).get(p);
const put = (p, c) => node.ctx.siteFiles.put(p, c, null);
const main = (res) =>
  (res.text.split('<main')[1] ?? res.text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

describe('site locales are part of the site tree', () => {
  test('English ships read-only with the code; edits are stored in the tree and win over it', async () => {
    assert.ok(
      !node.ctx.siteFiles.list().some((f) => f.path === 'locales/en.json'),
      'the tree holds only edits, so a fresh site has none',
    );
    assert.equal(typeof node.ctx.i18n.shippedLocales().en?.blog?.title, 'string');
    assert.match(main(await get('/blog')), /Blog/);
    // editing the wording in the site's language file changes the page at once
    await put(
      'locales/en.json',
      JSON.stringify({ blog: { title: 'Journal', empty: 'Coming soon.' } }),
    );
    const j = main(await get('/blog'));
    assert.match(j, /Journal/);
    assert.match(j, /Coming soon\./);
    // a string the site file no longer has falls back to the text written in the template
    await put('locales/en.json', JSON.stringify({ blog: { title: 'Journal' } }));
    assert.match(main(await get('/blog')), /Nothing published yet\./);
    // removing the edits shows the shipped wording again; nothing was ever written into site/
    await node.ctx.siteFiles.remove('locales/en.json', null);
    assert.match(main(await get('/blog')), /Blog/);
    assert.doesNotMatch(main(await get('/blog')), /Journal/);
  });

  test('language files are checked when saved, and mirrored to public/locales', async () => {
    const bad = (p, c, re) =>
      assert.rejects(put(p, c), (e) => e.status === 422 && re.test(e.message), `${p}: ${c}`);
    await bad('locales/e.json', '{"a":"A"}', /code such as en, hi or en-IN/i);
    await bad('locales/fr/x.json', '{}', /language file is locales/);
    await bad('locales/fr.json', '{oops', /not valid JSON/);
    await bad('locales/fr.json', '["a"]', /object of strings/);
    await bad('locales/fr.json', '{"a": 5}', /object of strings/);
    await bad('locales/fr.json', '{"bad key": "x"}', /keys use letters/);
    await bad('locales/fr.json', JSON.stringify({ a: 'x'.repeat(2001) }), /longer than 2000/);
    await bad(
      'locales/fr.json',
      JSON.stringify({ a: { b: { c: { d: { e: { f: 'x' } } } } } }),
      /nested too deeply/,
    );
    await put('locales/fr.json', JSON.stringify({ blog: { title: 'Journal' } }));
    const file = path.join(node.env.SITE_DIR, 'locales', 'fr.json');
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { blog: { title: 'Journal' } });
    await node.ctx.siteFiles.remove('locales/fr.json', null);
    assert.equal(fs.existsSync(file), false);
  });
});

describe('several languages, from the theme and from the site', () => {
  before(async () => {
    await node.ctx.themes.install(
      zipOf({
        'theme.json': JSON.stringify({ id: 'polyglot', name: 'Polyglot', version: '1.0.0' }),
        'layouts/default.html':
          '<html lang="{{ site.locale }}"><head>{{ seo.head }}{{ content_for_header }}</head><body><p id="skip">{{ "layout.skip" | t: "Skip" }}</p><p id="older">{{ "pagination.older" | t: "Older" }}</p>{{ content_for_layout }}</body></html>',
        'locales/en.json': JSON.stringify({
          layout: { skip: 'Skip to content' },
          pagination: { older: 'Older (theme)' },
        }),
        'locales/fr.json': JSON.stringify({
          layout: { skip: 'Aller au contenu' },
          pagination: { older: 'Plus ancien (thème)' },
        }),
        'locales/hi.json': JSON.stringify({ layout: { skip: 'सामग्री पर जाएं' } }),
      }),
      null,
    );
    await admin.post('/api/admin/themes/polyglot/activate').send({});
  });

  test('a language is available as soon as the theme or the site has a file for it', async () => {
    const langs = await node.ctx.i18n.languages();
    const by = Object.fromEntries(langs.map((l) => [l.code, l]));
    assert.equal(by.en.default, true);
    assert.equal(langs[0].code, 'en', 'the default language comes first');
    assert.equal(by.fr.theme, true);
    assert.equal(by.fr.site, false);
    assert.equal(by.hi.theme, true);
    assert.equal(by.fr.name.toLowerCase().includes('fran'), true, 'named in its own language');
    await put('locales/de.json', JSON.stringify({ blog: { title: 'Tagebuch' } }));
    assert.equal((await node.ctx.i18n.languages()).find((l) => l.code === 'de').site, true);
    await node.ctx.siteFiles.remove('locales/de.json', null);
  });

  test('with several languages switched on, /<code>/… is served for every language the site has, and only those', async () => {
    assert.equal(
      (await get('/fr/blog')).status,
      404,
      'off by default: /fr/blog is just an unknown address',
    );
    await node.ctx.settings.update('features', { values: { multilingual: true } });
    try {
      const fr = await get('/fr/blog');
      assert.equal(fr.status, 200);
      assert.match(fr.text, /<html lang="fr">/);
      assert.match(fr.text, /Aller au contenu/, 'the theme’s French');
      assert.match(fr.text, /Plus ancien \(thème\)/);
      assert.equal((await get('/de/blog')).status, 404, 'a language nobody has is not an address');
      assert.match((await get('/blog')).text, /<html lang="en">/);

      // the site's wording is merged over the theme's, per key, in that language
      await put('locales/fr.json', JSON.stringify({ pagination: { older: 'Plus ancien (site)' } }));
      const merged = await get('/fr/blog');
      assert.match(merged.text, /Plus ancien \(site\)/, 'the site wins');
      assert.match(merged.text, /Aller au contenu/, 'the theme still supplies the rest');
      assert.match(
        (await get('/blog')).text,
        /id="older">Older</,
        'English is untouched: the shipped wording beats the theme’s',
      );

      // Hindi exists only in the theme, and only for one key: the rest falls back to English
      const hi = await get('/hi/blog');
      assert.equal(hi.status, 200);
      assert.match(hi.text, /सामग्री पर जाएं/);
      assert.match(hi.text, /id="older">Older</);

      // the switcher list for templates
      await put(
        'pages/langs.html',
        '{% for l in site.languages %}<i class="l">{{ l.code }}{% if l.current %}*{% endif %}</i>{% endfor %}',
      );
      const codes = [...(await get('/fr/langs')).text.matchAll(/<i class="l">([^<]+)<\/i>/g)].map(
        (m) => m[1],
      );
      assert.deepEqual(codes.sort(), ['en', 'fr*', 'hi']);
    } finally {
      await node.ctx.settings.update('features', { reset: ['multilingual'] });
      await node.ctx.siteFiles.remove('locales/fr.json', null);
    }
  });

  test('a page that changes theme keeps the site’s own wording', async () => {
    await put('locales/en.json', JSON.stringify({ pagination: { older: 'Site says older' } }));
    assert.match((await get('/blog')).text, /Site says older/);
    await admin.post('/api/admin/themes/default/activate').send({});
    await admin.post('/api/admin/themes/polyglot/activate').send({});
    assert.match(
      (await get('/blog')).text,
      /Site says older/,
      'still there after switching away and back',
    );
    await admin.post('/api/admin/themes/default/activate').send({});
  });
});

describe('the translations API', () => {
  const mk = async (perms, email) => {
    const role = await node.ctx.users.createRole(
      { name: `r-${email}`, description: '', permissions: perms },
      null,
    );
    await node.ctx.users.createUser(
      { email, name: email, password: 'Some-long-pass-12', roleId: Number(role.id) },
      null,
    );
    return signedIn(node.app, { email, password: 'Some-long-pass-12' });
  };

  test('shows every string with the reference, the theme’s wording and the site’s override', async () => {
    await put('locales/en.json', JSON.stringify({ blog: { title: 'Site blog' } }));
    const list = (await admin.get('/api/admin/site/locales')).body;
    assert.equal(list.defaultLocale, 'en');
    assert.ok(list.languages.some((l) => l.code === 'en' && l.default));
    const en = (await admin.get('/api/admin/site/locales/en')).body;
    assert.equal(en.code, 'en');
    const blogTitle = en.entries.find((e) => e.key === 'blog.title');
    assert.equal(blogTitle.site, 'Site blog');
    assert.equal(blogTitle.value, 'Site blog');
    assert.equal(
      typeof blogTitle.shipped,
      'string',
      'the shipped wording stays visible underneath',
    );
    assert.notEqual(blogTitle.shipped, 'Site blog');
    const skip = en.entries.find((e) => e.key === 'layout.skip');
    assert.equal(skip.site, null);
    assert.equal(typeof skip.theme, 'string', 'the active theme’s string, when it has one');
    // a language nobody has yet lists every key as missing, with the default language as the reference
    const fr = (await admin.get('/api/admin/site/locales/fr')).body;
    const older = fr.entries.find((e) => e.key === 'pagination.older');
    assert.equal(older.value, null);
    assert.equal(older.reference, 'Older');
    assert.equal((await admin.get('/api/admin/site/locales/EN')).status, 422);
  });

  test('saving keeps only the site’s own wording, nests it, and removes the file when nothing is left', async () => {
    const before = node.ctx.siteFiles.version;
    const save = await admin.put('/api/admin/site/locales/fr').send({
      strings: {
        'blog.title': 'Journal',
        'pagination.older': '  Plus ancien  ',
        'blog.empty': '   ',
      },
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.changed, true);
    assert.equal(node.ctx.siteFiles.version, before + 1);
    assert.deepEqual(JSON.parse(node.ctx.siteFiles.get('locales/fr.json').content), {
      blog: { title: 'Journal' },
      pagination: { older: 'Plus ancien' },
    });
    // stale copy → conflict; right token → saved
    const stale = await admin
      .put('/api/admin/site/locales/fr')
      .send({ strings: { a: 'b' }, expectedHash: 'f'.repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(
      (
        await admin
          .put('/api/admin/site/locales/fr')
          .send({ strings: { 'blog.title': 'Carnet' }, expectedHash: save.body.hash })
      ).status,
      200,
    );
    // clashes and limits are explained
    const clash = await admin
      .put('/api/admin/site/locales/fr')
      .send({ strings: { blog: 'x', 'blog.title': 'y' } });
    assert.equal(clash.status, 422);
    assert.match(clash.body.error.message, /"blog" is a text/);
    assert.equal(
      (await admin.put('/api/admin/site/locales/fr').send({ strings: { 'bad key': 'x' } })).status,
      422,
    );
    assert.equal(
      (await admin.put('/api/admin/site/locales/fr').send({ strings: { a: 'x'.repeat(2001) } }))
        .status,
      422,
    );
    // emptying every override removes the file, so the theme shows through
    const cleared = await admin.put('/api/admin/site/locales/fr').send({ strings: {} });
    assert.equal(cleared.body.changed, true);
    assert.throws(
      () => node.ctx.siteFiles.get('locales/fr.json'),
      (e) => e.status === 404,
    );
    assert.equal(
      (await admin.put('/api/admin/site/locales/fr').send({ strings: {} })).body.changed,
      false,
    );
    const audit = await node.ctx
      .db('audit_logs')
      .where('action', 'like', 'site.file_%')
      .where('entity_id', 'locales/fr.json');
    assert.ok(audit.length >= 3, 'every save and the removal are audited');
  });

  test('reading and writing translations are separate permissions', async () => {
    const reader = await mk(['admin.access', 'locales.read'], 'reader@example.com');
    assert.equal((await reader.get('/api/admin/site/locales')).status, 200);
    assert.equal((await reader.get('/api/admin/site/locales/en')).status, 200);
    assert.equal(
      (await reader.put('/api/admin/site/locales/fr').send({ strings: { a: 'b' } })).status,
      403,
    );
    assert.equal((await reader.delete('/api/admin/site/locales/en')).status, 403);
    const none = await mk(['admin.access'], 'none@example.com');
    assert.equal((await none.get('/api/admin/site/locales')).status, 403);
    // the files API follows the same permission for language files
    assert.ok(
      (await reader.get('/api/admin/site/files')).body.files.every((f) => f.kind === 'locale'),
    );
    assert.equal(
      (await reader.put('/api/admin/site/file').send({ path: 'locales/es.json', content: '{}' }))
        .status,
      403,
    );
  });
});
