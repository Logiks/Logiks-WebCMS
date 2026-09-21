import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { Liquid } from 'liquidjs';
import { makeNode, signedIn, tmpDb, sharedBus, busFor, until } from './helpers.js';
import {
  createEngine,
  ALLOWED_FILTERS,
  ALLOWED_TAGS,
  Safe,
} from '../src/modules/themes/sandbox.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const MANIFEST = (o = {}) =>
  JSON.stringify({
    id: 'acme',
    name: 'Acme',
    version: '1.0.0',
    settings: { headline: { type: 'string', label: 'Headline', default: 'Hello from Acme' } },
    ...o,
  });
const BASE = () => ({
  'theme.json': MANIFEST(),
  'layouts/default.html':
    '<html><head>{{ content_for_header }}</head><body class="acme"><h1>{{ settings.headline }}</h1>{% render "theme/hello" %}{{ content_for_layout }}</body></html>',
  'components/hello.html': '<p>hello {{ site.name }}</p>',
  'assets/style.css': 'body{color:#123}',
});
function zipOf(files, { entries = [] } = {}) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  for (const fn of entries) fn(z);
  return z.toBuffer();
}
/** A zip whose entry name is set AFTER adding, so nothing sanitises it for us. */
function zipWithName(name, content = 'x') {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(BASE())) z.addFile(n, Buffer.from(c));
  z.addFile('placeholder.txt', Buffer.from(content));
  z.getEntries().find((e) => e.entryName === 'placeholder.txt').entryName = name;
  return z.toBuffer();
}
/** A zip in which one entry is marked as a symbolic link in its central-directory record (what `zip -y` produces). */
function zipWithSymlink(name) {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(BASE())) z.addFile(n, Buffer.from(c));
  z.addFile(name, Buffer.from('/etc/passwd'));
  const buf = z.toBuffer();
  for (let i = 0; i + 46 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    if (buf.subarray(i + 46, i + 46 + nameLen).toString() !== name) continue;
    buf.writeUInt16LE(0x031e, i + 4); // made by: Unix
    buf.writeUInt32LE((0o120777 << 16) >>> 0, i + 38); // external attributes: symlink, rwxrwxrwx
  }
  return buf;
}
const install = (agent, buf) =>
  agent.post('/api/admin/themes').set('content-type', 'application/zip').send(buf);
const refused = async (buf, re, label) => {
  const r = await install(admin, buf);
  assert.equal(r.status, 422, `${label}: ${JSON.stringify(r.body)}`);
  assert.match(r.body.error.message, re, label);
};

test('the built-in default theme is available, active, and its settings appear on the Settings screen', async () => {
  const list = (await admin.get('/api/admin/themes')).body.themes;
  const def = list.find((t) => t.id === 'default');
  assert.equal(def.active, true);
  assert.equal(def.source, 'disk');
  assert.equal(def.hasSettings, true);
  const s = (await admin.get('/api/admin/settings/theme_default')).body;
  assert.equal(s.title, 'Theme: Default');
  assert.deepEqual(
    s.fields.map((f) => f.key),
    ['accent_color', 'show_dates', 'footer_text'],
  );
  assert.equal(
    (
      await admin
        .put('/api/admin/settings/theme_default')
        .send({ values: { accent_color: '#c33' } })
    ).status,
    200,
  );
  assert.equal(node.ctx.settings.get('theme_default.accent_color'), '#c33');
  await node.ctx.settings.update('theme_default', { reset: ['accent_color'] });
});

test('an installed theme is stored, gets its own settings, renders, and can be activated and removed', async () => {
  const r = await install(admin, zipOf(BASE()));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.theme.id, 'acme');
  assert.equal(r.body.theme.source, 'db');
  assert.equal(node.ctx.settings.get('theme_acme.headline'), 'Hello from Acme');
  assert.equal(
    await node.ctx
      .db('theme_files')
      .where({ theme_id: 'acme' })
      .count({ n: '*' })
      .first()
      .then((x) => Number(x.n)),
    4,
  );

  const asset = await node.ctx.themes.asset('acme', 'style.css');
  assert.equal(asset.mime, 'text/css; charset=utf-8');
  assert.equal(asset.body.toString(), 'body{color:#123}');
  assert.equal(await node.ctx.themes.asset('acme', '../theme.json'), null);
  assert.equal(await node.ctx.themes.asset('acme', 'nope.css'), null);

  // it renders the site: the theme's frame and component around the site's own page
  assert.equal(node.ctx.themes.has('acme'), true);

  assert.equal(
    (await admin.delete('/api/admin/themes/acme').send()).status,
    204,
    'not active, so it can go',
  );
  await install(admin, zipOf(BASE()));
  const act = await admin.post('/api/admin/themes/acme/activate').send({});
  assert.equal(act.status, 200);
  assert.equal(node.ctx.settings.get('site.theme'), 'acme');
  assert.equal(node.ctx.themes.activeId(), 'acme');
  const live = await request(node.app).get('/');
  assert.equal(live.status, 200);
  assert.match(
    live.text,
    /<body class="acme"><h1>Hello from Acme<\/h1><div data-c="[a-f0-9]{8}"><p>hello /,
  );
  assert.equal((await admin.delete('/api/admin/themes/acme')).status, 409, 'in use');
  assert.equal((await admin.post('/api/admin/themes/nope/activate').send({})).status, 404);
  await admin.post('/api/admin/themes/default/activate').send({});
  assert.equal((await admin.delete('/api/admin/themes/acme')).status, 204);
  assert.equal(node.ctx.themes.has('acme'), false);
  assert.equal(
    (await admin.delete('/api/admin/themes/default')).status,
    409,
    'built-in themes stay',
  );
  const actions = (await node.ctx.audit.list({ action: 'theme.', limit: 20 })).map((a) => a.action);
  for (const a of ['theme.install', 'theme.activate', 'theme.delete'])
    assert.ok(actions.includes(a), a);
});

test('updating an installed theme replaces its files and changes its hash (so asset URLs change)', async () => {
  await install(admin, zipOf(BASE()));
  const h1 = node.ctx.themes.hash('acme');
  await install(
    admin,
    zipOf({
      ...BASE(),
      'assets/style.css': 'body{color:red}',
      'theme.json': MANIFEST({ version: '1.1.0' }),
    }),
  );
  assert.notEqual(node.ctx.themes.hash('acme'), h1);
  assert.equal(
    (await node.ctx.themes.asset('acme', 'style.css')).body.toString(),
    'body{color:red}',
  );
  assert.equal(node.ctx.themes.list().find((t) => t.id === 'acme').version, '1.1.0');
  await admin.delete('/api/admin/themes/acme');
});

test('a theme zipped inside a folder installs; junk from macOS archives is ignored', async () => {
  const files = Object.fromEntries(Object.entries(BASE()).map(([k, v]) => [`acme-theme/${k}`, v]));
  files['__MACOSX/acme-theme/._theme.json'] = 'junk';
  files['acme-theme/.DS_Store'] = 'junk';
  assert.equal((await install(admin, zipOf(files))).status, 201);
  await admin.delete('/api/admin/themes/acme');
});

test('unsafe packages are refused before anything is stored: traversal, absolute paths, symlinks, odd types, missing pieces', async () => {
  await refused(zipWithName('../evil.txt'), /Unsafe file/, 'dot-dot');
  await refused(zipWithName('layouts/../../evil.txt'), /Unsafe file/, 'nested dot-dot');
  await refused(zipWithName('/etc/cron.d/x.txt'), /Unsafe file/, 'absolute');
  await refused(zipWithName('C:/windows/x.txt'), /Unsafe file/, 'drive letter');
  await refused(zipWithName('assets\\..\\x.txt'), /Unsafe file/, 'backslash');
  await refused(zipWithSymlink('assets/link.txt'), /symbolic link/, 'symlink');
  await refused(
    zipOf({ ...BASE(), 'assets/shell.php': '<?php ?>' }),
    /file type themes can't contain/,
    'php',
  );
  await refused(zipOf({ ...BASE(), 'assets/run.exe': 'MZ' }), /file type/, 'exe');
  await refused(
    zipOf({ ...BASE(), 'src/other.html': 'x' }),
    /outside the theme folders/,
    'stray folder',
  );
  const noLayout = BASE();
  delete noLayout['layouts/default.html'];
  await refused(zipOf(noLayout), /needs layouts\/default\.html/, 'no layout');
  await refused(
    zipOf({ ...BASE(), 'theme.json': '{not json' }),
    /theme\.json is not valid JSON/,
    'bad json',
  );
  await refused(
    zipOf({ ...BASE(), 'theme.json': MANIFEST({ id: 'Bad-Id' }) }),
    /theme id is lowercase/,
    'bad id',
  );
  await refused(
    zipOf({ ...BASE(), 'theme.json': MANIFEST({ version: 'one' }) }),
    /version looks like 1\.0\.0/,
    'bad version',
  );
  await refused(
    zipOf({ ...BASE(), 'theme.json': MANIFEST({ settings: { x: { type: 'json', label: 'X' } } }) }),
    /theme\.json/,
    'unsupported setting type',
  );
  await refused(Buffer.from('this is not a zip'), /valid zip/, 'not a zip');
  await refused(zipOf({ 'readme.md': 'x' }), /missing theme\.json/, 'no manifest');
  assert.equal(node.ctx.themes.has('acme'), false, 'nothing was stored by any refused package');
  assert.equal(Number((await node.ctx.db('theme_files').count({ n: '*' }).first()).n), 0);
});

test('size limits: a huge file, an inflated archive, too many files, and an oversized upload are all refused', async () => {
  await refused(
    zipOf({ ...BASE(), 'assets/big.css': 'a'.repeat(2 * 1024 * 1024 + 1) }),
    /too large/,
    'one huge file',
  );
  await refused(
    zipOf({ ...BASE(), 'components/huge.html': 'a'.repeat(310 * 1024) }),
    /too large/,
    'huge template',
  );
  const many = BASE();
  for (let i = 0; i < 401; i++) many[`assets/f${i}.css`] = 'x';
  await refused(zipOf(many), /more than 400 files/, 'many files');
  const chunk = 'b'.repeat(1.9 * 1024 * 1024);
  const total = BASE();
  for (let i = 0; i < 6; i++) total[`assets/c${i}.css`] = chunk + i; // compresses to almost nothing, expands to >10 MB
  const bomb = zipOf(total);
  assert.ok(bomb.length < 200 * 1024, 'the archive itself is small');
  await refused(bomb, /larger than 10 MB unpacked/, 'zip bomb');
  await node.ctx.settings.update('themes', { values: { max_zip_mb: 1 } });
  const r = await install(admin, Buffer.alloc(1024 * 1024 + 10, 1));
  assert.equal(r.status, 413);
  await node.ctx.settings.update('themes', { reset: ['max_zip_mb'] });
});

test('JavaScript in a theme is refused unless the site allows it', async () => {
  const withJs = zipOf({ ...BASE(), 'assets/app.js': 'console.log(1)' });
  await refused(withJs, /doesn't allow themes to ship scripts/, 'js off');
  await node.ctx.settings.update('themes', { values: { allow_js: true } });
  assert.equal((await install(admin, withJs)).status, 201);
  await admin.delete('/api/admin/themes/acme');
  await node.ctx.settings.update('themes', { reset: ['allow_js'] });
});

test('broken templates are refused at install with the file named: syntax errors, unknown tags and filters, endless loops', async () => {
  const comp = (src) => ({ ...BASE(), 'components/hello.html': src });
  await refused(
    zipOf({ ...BASE(), 'components/bad.html': '{% if x %}never closed' }),
    /components\/bad\.html/,
    'unclosed tag',
  );
  await refused(
    zipOf(comp('{{ site.name | totally_made_up }}')),
    /components\/hello\.html.*totally_made_up/,
    'unknown filter',
  );
  await refused(
    zipOf(comp('{{ site.name | raw }}')),
    /components\/hello\.html/,
    'raw filter is gone',
  );
  await refused(zipOf(comp("{% include 'x' %}")), /components\/hello\.html/, 'include tag is gone');
  await refused(
    zipOf(comp('{% for i in (1..99999999) %}<p>{{ i }}</p>{% endfor %}')),
    /layouts\/default\.html.*limit/,
    'endless loop',
  );
  await refused(
    zipOf(comp("{% render '../layouts/default' %}")),
    /layouts\/default\.html/,
    'reaching another folder',
  );
});

test('the sandbox: escaping, prototype access, file access, loops and memory', async () => {
  const files = new Map([
    ['layouts/default.html', '{{ content_for_layout }}'],
    ['components/ok.html', 'snippet says {{ v }}'],
    ['components/loop.html', "{% render 'loop' %}"],
    ['layouts/secret.html', 'TOP SECRET'],
  ]);
  const engine = createEngine(files, { limits: { renderMs: 300, memoryMb: 8 } });
  const run = (tpl, scope = {}) => engine.parseAndRender(tpl, scope);
  const fails = async (tpl, re, label) =>
    await assert.rejects(run(tpl), (e) => re.test(e.message), label);

  // output is escaped; only Safe values pass through
  assert.equal(
    await run('{{ x }}', { x: '<script>alert(1)</script>' }),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  assert.equal(await run('{{ x }}', { x: new Safe('<b>ok</b>') }), '<b>ok</b>');
  assert.equal(await run('{{ x | upcase }}', { x: '<b>' }), '&lt;B&gt;');
  await fails('{{ x | raw }}', /undefined filter/i, 'no raw filter');
  await fails("{% include 'ok' %}", /tag|include/i, 'no include tag');

  // JavaScript reachability
  assert.equal(await run('{{ x.constructor.constructor }}{{ x.constructor.name }}', { x: {} }), '');
  assert.equal(
    await run(
      '{{ x.__proto__ }}{{ x.constructor }}{{ process.env.HOME }}{{ globalThis }}{{ require }}',
      { x: {} },
    ),
    '',
  );
  assert.equal(await run('{{ "abc".constructor }}{{ arr.constructor }}', { arr: [1] }), '');

  // files: only the theme's own partial folders, nothing outside them
  assert.equal(await run("{% render 'ok', v: 1 %}"), 'snippet says 1');
  for (const p of [
    '../layouts/secret',
    '/etc/passwd',
    '../../package',
    'components/../layouts/secret',
    'C:\\\\windows\\\\win',
  ])
    await fails(`{% render '${p}' %}`, /ENOENT|No such|lookup/i, p);
  await fails("{% layout '../components/ok' %}", /ENOENT|No such|lookup/i, 'layout traversal');
  await fails(
    "{% assign f = '../layouts/secret' %}{% render f %}",
    /ENOENT|No such|lookup/i,
    'dynamic partial name',
  );

  // resource limits
  const t0 = Date.now();
  await fails('{% for i in (1..99999999) %}{{ i }}{% endfor %}', /limit/i, 'huge loop');
  await fails(
    '{% for a in (1..9999) %}{% for b in (1..9999) %}x{% endfor %}{% endfor %}',
    /limit/i,
    'nested loops',
  );
  await fails(
    '{% capture x %}{% for i in (1..300000) %}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa{% endfor %}{% endcapture %}{{ x }}',
    /limit|memory/i,
    'memory',
  );
  await fails("{% render 'loop' %}", /limit|depth|stack|recurs/i, 'a snippet that renders itself');
  assert.ok(Date.now() - t0 < 5000, 'all of that was stopped promptly');
  await assert.rejects(
    engine.parseAndRender('x'.repeat(600_000)),
    /limit|parse/i,
    'oversized template',
  );
});

test('the tag and filter allow-lists match the engine: an upgrade cannot quietly add capabilities', () => {
  const stock = new Liquid();
  const engine = createEngine(new Map(), { limits: { renderMs: 100, memoryMb: 4 } });
  const removedFilters = Object.keys(stock.filters)
    .filter((f) => !ALLOWED_FILTERS.includes(f))
    .sort();
  assert.deepEqual(
    removedFilters,
    ['raw', 'sample'],
    'every stock filter is either allowed or deliberately removed',
  );
  const removedTags = Object.keys(stock.tags)
    .filter((t) => !ALLOWED_TAGS.includes(t))
    .sort();
  assert.deepEqual(
    removedTags,
    ['include'],
    'every stock tag is either allowed or deliberately removed',
  );
  assert.deepEqual(Object.keys(engine.tags).sort(), [...ALLOWED_TAGS].sort());
  assert.deepEqual(
    Object.keys(engine.filters).sort(),
    Object.keys(stock.filters)
      .filter((f) => ALLOWED_FILTERS.includes(f))
      .sort(),
  );
});

test('cluster: installing on one server makes the theme, its settings and activation appear on the others', async () => {
  const db = tmpDb();
  const emitter = sharedBus();
  const a = await makeNode({ dbUrl: db.url, bus: busFor(emitter) });
  const b = await makeNode({ dbUrl: db.url, bus: busFor(emitter) });
  try {
    assert.equal(b.ctx.themes.has('acme'), false);
    const agent = await signedIn(a.app);
    assert.equal((await install(agent, zipOf(BASE()))).status, 201);
    await until(() => b.ctx.themes.has('acme'), { timeout: 3000 });
    await until(() => b.ctx.settings.registry.has('theme_acme'), { timeout: 3000 });
    assert.equal(b.ctx.settings.get('theme_acme.headline'), 'Hello from Acme');
    assert.equal(
      (await b.ctx.themes.asset('acme', 'style.css')).body.toString(),
      'body{color:#123}',
    );

    await agent.post('/api/admin/themes/acme/activate').send({});
    await until(() => b.ctx.themes.activeId() === 'acme', { timeout: 3000 });
    assert.match((await request(b.app).get('/')).text, /class="acme"/);

    await agent.post('/api/admin/themes/default/activate').send({});
    await agent.delete('/api/admin/themes/acme');
    await until(() => !b.ctx.themes.has('acme'), { timeout: 3000 });
    assert.equal(b.ctx.settings.registry.has('theme_acme'), false);
  } finally {
    await Promise.all([a.close(), b.close()]);
    db.cleanup();
  }
});

test('a missing active theme falls back to the default rather than taking the site down', async () => {
  await node.ctx.settings.update('site', { values: { theme: 'ghost' } });
  assert.equal(node.ctx.themes.activeId(), 'default');
  await node.ctx.settings.update('site', { reset: ['theme'] });
});

test('permissions: viewing and managing themes are separate', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'ThemeLook', permissions: ['admin.access', 'themes.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'tl@example.com', name: 'TL', password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  const v = await signedIn(node.app, { email: 'tl@example.com', password: 'Some-long-pass-12' });
  assert.equal((await v.get('/api/admin/themes')).status, 200);
  assert.equal((await install(v, zipOf(BASE()))).status, 403);
  assert.equal((await v.post('/api/admin/themes/default/activate').send({})).status, 403);
});

test('the site-tree anatomy is checked at install: layouts and components are compiled, css and meta validated', async () => {
  const site = () => ({
    'theme.json': MANIFEST({ id: 'sitey' }),
    'layouts/default.html':
      '<html><head>{{ content_for_header }}</head><body>{% render "theme/top" %}{{ content_for_layout }}</body></html>',
    'components/top.html':
      '<style>:host{display:block}</style><header>{{ site.name | t }}</header>',
  });
  const ok = await install(admin, zipOf(site()));
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); // accepted: it has layouts/default.html and no classic templates
  assert.equal((await admin.delete('/api/admin/themes/sitey')).status, 204);

  await refused(
    zipOf({ ...site(), 'layouts/default.html': '<body>{% if never_closed %}</body>' }),
    /layouts\/default\.html/,
    'broken layout',
  );
  await refused(
    zipOf({ ...site(), 'layouts/default.html': '<body>{% render "theme/missing" %}</body>' }),
    /layouts\/default\.html/,
    'layout uses a component that does not exist',
  );
  await refused(
    zipOf({
      ...site(),
      'components/top.html': '<style>@import url(https://evil.example/x.css);</style><p>x</p>',
    }),
    /components\/top\.html: @import/,
    'component css',
  );
  await refused(
    zipOf({ ...site(), 'components/top.html': '<script>alert(1)</script>' }),
    /components\/top\.html: This component contains a <script>/,
    'component script',
  );
  await refused(
    zipOf({ ...site(), 'layouts/nope.html': 'x'.repeat(301 * 1024) }),
    /too large/,
    'huge template',
  );
});
