import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
const get = (p) => request(node.app).get(p);
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const mkUser = async (perms, email) => {
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
const file = (id, p) => `/api/admin/themes/${id}/file?path=${encodeURIComponent(p)}`;
/** The theme's stylesheet as a visitor gets it: follow the <link> the home page prints. */
async function liveStylesheets() {
  const html = (await get('/')).text;
  const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  return Promise.all(hrefs.map(async (h) => (await get(h)).text));
}

describe('Theme editor', () => {
  test('built-in themes list their files but are read-only', async () => {
    const r = await admin.get('/api/admin/themes/default/files');
    assert.equal(r.status, 200);
    assert.equal(r.body.editable, false);
    assert.ok(r.body.files.some((f) => f.path === 'layouts/default.html'));
    const one = await admin.get(file('default', 'layouts/default.html'));
    assert.equal(one.status, 200);
    assert.match(one.body.file.content, /content_for_layout/);
    const save = await admin.put(file('default', 'styles/site.css')).send({ content: 'x{}' });
    assert.equal(save.status, 409);
    assert.match(save.body.error.message, /Duplicate it/);
  });

  test('duplicate a built-in theme, edit its stylesheet, make it live: visitors get the edit', async () => {
    await node.ctx.settings.update('theme_default', { values: { accent_color: '#123456' } }, null);
    const dup = await admin
      .post('/api/admin/themes/default/duplicate')
      .send({ id: 'house', name: 'House style' });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.equal(dup.body.theme.source, 'db');
    assert.equal(
      node.ctx.settings.get('theme_house.accent_color'),
      '#123456',
      "the copy starts with the original's options",
    );
    assert.equal(
      (await admin.post('/api/admin/themes/default/duplicate').send({ id: 'house' })).status,
      409,
      'ids are unique',
    );

    const files = (await admin.get('/api/admin/themes/house/files')).body;
    assert.equal(files.editable, true);
    const css = files.files.find((f) => f.path.startsWith('styles/') && f.path.endsWith('.css'));
    const original = (await admin.get(file('house', css.path))).body.file.content;
    const saved = await admin
      .put(file('house', css.path))
      .send({ content: `${original}\n.edited-in-admin{color:red}` });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    await admin.post('/api/admin/themes/house/activate').send({});
    assert.ok((await liveStylesheets()).some((c) => c.includes('.edited-in-admin')));

    const audit = await node.ctx.db('audit_logs').where({ action: 'theme.file.save' }).first();
    assert.ok(audit, 'saves are audited');
    await admin.post('/api/admin/themes/default/activate').send({});
  });

  test('a save is checked like an upload: broken templates, scripts and unsafe paths are refused, and nothing changes', async () => {
    const before_ = (await admin.get(file('house', 'layouts/default.html'))).body.file.content;
    const broken = await admin
      .put(file('house', 'layouts/default.html'))
      .send({ content: '<html>{% if %}</html>' });
    assert.equal(broken.status, 422);
    assert.match(broken.body.error.message, /layouts\/default\.html/);
    assert.equal(
      (await admin.get(file('house', 'layouts/default.html'))).body.file.content,
      before_,
    );

    const js = await admin.put(file('house', 'scripts/x.js')).send({ content: 'alert(1)' });
    assert.equal(js.status, 422);
    assert.match(js.body.error.message, /JavaScript/);

    for (const p of ['../escape.css', 'styles/../../x.css', '/etc/x.css', 'other/x.css'])
      assert.equal((await admin.put(file('house', p)).send({ content: 'a{}' })).status, 422, p);

    const badJson = await admin.put(file('house', 'theme.json')).send({ content: '{"id":"other"' });
    assert.equal(badJson.status, 422);
    const renamed = await admin
      .put(file('house', 'theme.json'))
      .send({ content: JSON.stringify({ id: 'other', name: 'X', version: '1.0.0' }) });
    assert.equal(renamed.status, 422);
    assert.match(renamed.body.error.message, /must stay "house"/);
  });

  test('new files, uploads and deletes; required files stay', async () => {
    const made = await admin
      .put(file('house', 'components/banner.html'))
      .send({ content: '<div class="banner">{{ site.name }}</div>' });
    assert.equal(made.status, 200);
    assert.ok(made.body.files.some((f) => f.path === 'components/banner.html'));

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const up = await admin
      .post(file('house', 'assets/dot.png'))
      .set('content-type', 'application/octet-stream')
      .send(png);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal((await admin.get(file('house', 'assets/dot.png'))).body.file.text, false);
    assert.equal(
      (await admin.put(file('house', 'assets/dot2.png')).send({ content: 'x' })).status,
      422,
      'images are uploaded, not typed',
    );

    assert.equal((await admin.delete(file('house', 'components/banner.html'))).status, 200);
    assert.equal((await admin.get(file('house', 'components/banner.html'))).status, 404);
    assert.equal((await admin.delete(file('house', 'layouts/default.html'))).status, 409);
    assert.equal((await admin.delete(file('house', 'theme.json'))).status, 409);
  });

  test('export gives a zip the installer accepts', async () => {
    const r = await admin
      .get('/api/admin/themes/house/export')
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(r.status, 200);
    const zip = new AdmZip(r.body);
    const names = zip.getEntries().map((e) => e.entryName);
    assert.ok(names.includes('theme.json') && names.includes('assets/dot.png'));
    // Same zip under another id installs cleanly.
    const manifest = JSON.parse(zip.readAsText('theme.json'));
    zip.updateFile('theme.json', Buffer.from(JSON.stringify({ ...manifest, id: 'house_two' })));
    const inst = await admin
      .post('/api/admin/themes')
      .set('content-type', 'application/zip')
      .send(zip.toBuffer());
    assert.equal(inst.status, 201, JSON.stringify(inst.body));
  });

  test('permissions: themes.read may look, only themes.edit may save', async () => {
    const reader = await mkUser(['admin.access', 'themes.read'], 'te-reader@example.com');
    assert.equal((await reader.get('/api/admin/themes/house/files')).status, 200);
    assert.equal(
      (await reader.put(file('house', 'styles/new.css')).send({ content: 'a{}' })).status,
      403,
    );
    assert.equal(
      (await reader.post('/api/admin/themes/house/duplicate').send({ id: 'nope' })).status,
      403,
    );
    assert.equal(
      (await reader.put('/api/admin/themes/house/customize').send({ values: {} })).status,
      403,
    );
  });
});

describe('Customize: theme options and custom CSS', () => {
  test('custom CSS is printed after the theme’s styles on every page, per theme', async () => {
    const r = await admin
      .put('/api/admin/themes/default/customize')
      .send({ values: { custom_css: '.brand-x { color: #c33 }' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const html = (await get('/')).text;
    const at = html.indexOf('<style data-cms="custom-css">.brand-x { color: #c33 }</style>');
    assert.ok(at > 0, 'custom css is on the page');
    assert.ok(
      html.lastIndexOf('<link rel="stylesheet"', at) > 0 &&
        html.indexOf('<link rel="stylesheet"', at) === -1,
      'after every stylesheet',
    );
    await admin.post('/api/admin/themes/house/activate').send({});
    assert.doesNotMatch((await get('/')).text, /brand-x/, 'another theme has its own');
    await admin.post('/api/admin/themes/default/activate').send({});
  });

  test('custom CSS that could escape <style> or load/run something is refused', async () => {
    for (const css of [
      'a{}</style><script>alert(1)</script>',
      '@import url(https://evil.example/x.css);',
      'a{background:url(javascript:alert(1))}',
      'a{behavior:url(x.htc)}',
    ]) {
      const r = await admin
        .put('/api/admin/themes/default/customize')
        .send({ values: { custom_css: css } });
      assert.equal(r.status, 422, css);
    }
    assert.equal(node.ctx.settings.get('theme_default.custom_css'), '.brand-x { color: #c33 }');
  });

  test('preview renders draft options and CSS without saving anything', async () => {
    const r = await admin.post('/api/admin/themes/default/preview').send({
      path: '/',
      values: { custom_css: '.draft-only{}', footer_text: 'Draft footer words' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.html, /\.draft-only\{\}/);
    assert.match(r.body.html, /Draft footer words/, 'draft options reach the templates');
    assert.doesNotMatch(r.body.html, /brand-x/, 'the draft replaces the saved CSS');
    assert.equal(node.ctx.settings.get('theme_default.custom_css'), '.brand-x { color: #c33 }');
    assert.doesNotMatch((await get('/')).text, /draft-only/);

    const bad = await admin
      .post('/api/admin/themes/default/preview')
      .send({ values: { custom_css: '</style>' } });
    assert.equal(bad.status, 422);
    const other = await admin.post('/api/admin/themes/house/preview').send({ path: '/' });
    assert.equal(other.status, 200, 'a theme that is not live can be previewed');
  });
});
