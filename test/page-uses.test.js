import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { usesOf, inferUses, operationFor } from '../src/modules/site/uses.js';

let node, admin;
const get = (p) => request(node.app).get(p);
const put = (p, content) => node.ctx.siteFiles.put(p, content, null);
const mk = (title) =>
  node.ctx.content.create(
    'post',
    {
      title,
      status: 'published',
      data: { body: { blocks: [{ type: 'paragraph', data: { text: `About ${title}` } }] } },
    },
    null,
  );

const LIST = `<script type="application/json" data-cms="meta">
{"api":[{"name":"posts","url":"/api/v1/content/post?per_page=5"}]}
</script>
<ul>{% for p in api.posts.items %}<li class="item">{{ p.title }}</li>{% endfor %}</ul>`;
const MENU = `<script type="application/json" data-cms="meta">
{"api":[{"name":"m","url":"/api/public/menus/main"}]}
</script>
<nav class="menu">MENU-OK</nav>`;

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await mk('Hello uses');
  await node.ctx.site.menus.save('main', { title: 'Main', items: [{ label: 'Home', url: '/' }] });
  await put('components/plist.html', LIST);
  await put('components/pmenu.html', MENU);
});
after(() => node.close());

describe('uses (front matter)', () => {
  test('nothing declared means nothing is enforced; "none" means no module data', () => {
    assert.equal(usesOf({}), null);
    assert.deepEqual([...usesOf({ uses: 'content, menus' }).modules], ['content', 'menus']);
    assert.equal(usesOf({ uses: 'none' }).modules.size, 0);
    assert.equal(usesOf({ uses: 'services', uses_services: 'a, b' }).services.has('b'), true);
  });

  test('a bad uses value is explained when the page is saved', async () => {
    await assert.rejects(
      put('pages/bad.html', '---\nuses: Content!\n---\nx'),
      /uses: list module ids/,
    );
  });
});

describe('rendering enforces a declared uses', () => {
  test('a page with no uses reads whatever its components ask for (unchanged behaviour)', async () => {
    await put('pages/free.html', '{% render "plist" %}{% render "pmenu" %}');
    const r = await get('/free');
    assert.equal(r.status, 200);
    assert.match(r.text, /Hello uses/);
    assert.match(r.text, /MENU-OK/);
  });

  test('a page that lists only content gets posts, and nothing from a module it left out', async () => {
    await put(
      'pages/partial.html',
      '---\nuses: content\n---\n{% render "plist" %}<p id="m">{{ "x" }}</p>',
    );
    const ok = await get('/partial');
    assert.match(ok.text, /Hello uses/);

    await put(
      'components/menu-count.html',
      `<script type="application/json" data-cms="meta">
{"api":[{"name":"m","url":"/api/v1/menus/main"}]}
</script><span id="menu-state">{% if api.m %}LOADED{% else %}MISSING{% endif %}</span>`,
    );
    await put('pages/menu-free.html', '{% render "menu-count" %}');
    await put('pages/menu-bound.html', '---\nuses: content\n---\n{% render "menu-count" %}');
    assert.match((await get('/menu-free')).text, /LOADED/);
    assert.match((await get('/menu-bound')).text, /MISSING/);
  });

  test('"uses: none" blocks every module, and listing the module again lets the data back in', async () => {
    await put('pages/none.html', '---\nuses: none\n---\n{% render "plist" %}');
    assert.doesNotMatch((await get('/none')).text, /Hello uses/);
    await put('pages/none.html', '---\nuses: content\n---\n{% render "plist" %}');
    assert.match((await get('/none')).text, /Hello uses/);
  });

  test('uses_services narrows which Service a page may run', async () => {
    const { ctx } = node;
    await ctx.settings.update('features', { values: { services: true } });
    const called = [];
    const real = ctx.services.run;
    ctx.services.getPublic = async (slug) => ({ slug });
    ctx.services.run = async (d) => (called.push(d.slug), { rows: [d.slug] });
    try {
      await put(
        'components/svc.html',
        `<script type="application/json" data-cms="meta">
{"api":[{"name":"s","url":"/api/v1/services/allowed"},{"name":"t","url":"/api/v1/services/other"}]}
</script><i>{% if api.s %}S-OK{% endif %}</i><i>{% if api.t %}T-OK{% endif %}</i>`,
      );
      await put(
        'pages/svc.html',
        '---\nuses: services\nuses_services: allowed\n---\n{% render "svc" %}',
      );
      const r = await get('/svc');
      assert.match(r.text, /S-OK/);
      assert.doesNotMatch(r.text, /T-OK/);
      assert.deepEqual(called, ['allowed']);
    } finally {
      ctx.services.run = real;
      delete ctx.services.getPublic;
      await ctx.settings.update('features', { values: { services: false } });
    }
  });

  test('the theme’s own frame is not held to a page’s uses', async () => {
    // The built-in theme's header reads the main menu; a content-only page must still show it.
    const r = await get('/partial');
    assert.equal(r.status, 200);
    assert.match(r.text, /<nav|<header/);
  });
});

describe('inference and issues', () => {
  const ops = () => node.ctx.modules.operations();

  test('operationFor maps an address, Liquid included, to the owning module', () => {
    assert.equal(operationFor(ops(), '/api/public/content/post?per_page=5').op.module, 'content');
    assert.equal(
      operationFor(ops(), '/api/v1/content/{{ type }}/{{ slug }}').op.id,
      'content.item',
    );
    assert.equal(operationFor(ops(), '/api/v1/menus/main').op.module, 'site');
    assert.equal(operationFor(ops(), '/api/v1/services/team').params.slug, 'team');
    assert.equal(operationFor(ops(), '/api/v1/nothing/here'), null);
  });

  test('inferUses follows {% render %} through components and skips the theme', () => {
    const files = {
      'components/outer.html': '{% render "plist" %}{% render "theme/header" %}',
      'components/plist.html': LIST,
    };
    const got = inferUses({
      source: '{% render "outer" %}',
      read: (p) => files[p] ?? null,
      ops: ops(),
    });
    assert.deepEqual(got.modules, ['content']);
    assert.deepEqual(got.components, ['outer', 'plist']);
  });

  test('POST /site/uses reports what is declared, needed and missing', async () => {
    const r = await admin
      .post('/api/admin/site/uses')
      .send({ content: '---\nuses: menus\n---\n{% render "plist" %}' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.inferred.modules, ['content']);
    assert.deepEqual(r.body.declared.modules, ['menus']);
    const codes = r.body.issues.map((i) => i.code);
    assert.ok(codes.includes('undeclared_module'));
    assert.ok(codes.includes('unknown_module')); // "menus" is a path, not a module id: the module is "site"
    assert.ok(r.body.modules.some((m) => m.id === 'content' && m.data));

    const off = await admin
      .post('/api/admin/site/uses')
      .send({ content: '---\nuses: services\n---\nx' });
    assert.ok(off.body.issues.some((i) => i.code === 'module_disabled'));

    const none = await admin.post('/api/admin/site/uses').send({ content: '{% render "plist" %}' });
    assert.equal(none.body.declared, null);
    assert.deepEqual(none.body.issues, []);

    assert.equal(
      (await admin.post('/api/admin/site/uses').send({ content: '---\nuses: A B\n---\n' })).status,
      422,
    );
  });

  test('it needs pages.read', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'no-pages', description: '', permissions: ['admin.access'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'np@example.com',
        name: 'np',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const u = await signedIn(node.app, { email: 'np@example.com', password: 'Some-long-pass-12' });
    assert.equal((await u.post('/api/admin/site/uses').send({ content: 'x' })).status, 403);
  });
});
