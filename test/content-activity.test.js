import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn, ADMIN } from './helpers.js';

let node, admin;
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
const blocks = (...texts) => ({
  blocks: texts.map((text) => ({ type: 'paragraph', data: { text } })),
});
const page = (title, extra = {}) => ({ title, data: { body: blocks(`About ${title}`) }, ...extra });

describe('content.activity permission', () => {
  test('is required, and is separate from audit.read (an editor sees this without the security-tier permission)', async () => {
    const nobody = await mkUser(['admin.access'], 'ca-nobody@example.com');
    assert.equal((await nobody.get('/api/admin/audit/content')).status, 403);

    const auditorOnly = await mkUser(['admin.access', 'audit.read'], 'ca-auditor@example.com');
    assert.equal(
      (await auditorOnly.get('/api/admin/audit/content')).status,
      403,
      'audit.read alone does not grant content.activity',
    );

    const editor = await mkUser(['admin.access', 'content.activity'], 'ca-editor@example.com');
    assert.equal((await editor.get('/api/admin/audit/content')).status, 200);
    assert.equal(
      (await editor.get('/api/admin/audit')).status,
      403,
      'content.activity alone does not grant the general (security) audit log',
    );
  });
});

describe('content activity: content-authoring actions across every module, never security events', () => {
  test('content entries, site pages, menus, redirects and SEO rules all show up with a readable detail', async () => {
    await node.ctx.audit.log({
      actor: null,
      action: 'auth.login',
      entity: 'session',
      meta: { email: 'irrelevant@example.com' },
    });

    const entry = (await admin.post('/api/admin/content/types/page/entries').send(page('Widgets')))
      .body.entry;
    await admin
      .put(`/api/admin/content/entries/${entry.id}`)
      .send({ title: 'Widgets 2', version: 1 });

    await admin
      .put('/api/admin/site/file')
      .send({ path: 'pages/about-us.html', content: '---\ntitle: About\n---\n<p>Hi</p>' });
    await admin.delete('/api/admin/site/file?path=pages/about-us.html');

    await admin.put('/api/admin/menus/main').send({ items: [] });

    const redirect = (
      await admin
        .post('/api/admin/redirects')
        .send({ from: '/old-page', to: '/new-page', status: 301 })
    ).body.redirect;
    await admin.delete(`/api/admin/redirects/${redirect.id}`);

    const rule = (await admin.post('/api/admin/seo/rules').send({ pattern: '/promo' })).body.rule;
    await admin.put(`/api/admin/seo/rules/${rule.id}`).send({ pattern: '/promo-2' });
    await admin.delete(`/api/admin/seo/rules/${rule.id}`);

    const { entries } = (await admin.get('/api/admin/audit/content?limit=50')).body;
    const actions = entries.map((e) => e.action);

    assert.ok(!actions.includes('auth.login'), 'security events never appear in Content Activity');
    for (const a of [
      'content.create',
      'content.update',
      'site.file_created',
      'site.file_deleted',
      'redirect.create',
      'redirect.delete',
      'seo.rule_created',
      'seo.rule_updated',
      'seo.rule_deleted',
    ])
      assert.ok(actions.includes(a), `expected ${a} in Content Activity`);
    assert.ok(actions.includes('menu.create') || actions.includes('menu.update'));

    assert.equal(entries.find((e) => e.action === 'seo.rule_created').meta.pattern, '/promo');
    assert.equal(entries.find((e) => e.action === 'redirect.create').meta.from, '/old-page');
    assert.equal(entries.find((e) => e.action === 'content.create').meta.title, 'Widgets');
  });
});

describe('filters and export mirror the general audit log', () => {
  test('actorEmail and date range narrow the list; export gives CSV/JSON, scoped to content actions', async () => {
    const byActor = await admin.get(
      `/api/admin/audit/content?actorEmail=${encodeURIComponent(ADMIN.email)}`,
    );
    assert.ok(byActor.body.entries.length);
    assert.ok(byActor.body.entries.every((e) => e.actor === ADMIN.email));

    const future = Date.now() + 3_600_000;
    const empty = await admin.get(`/api/admin/audit/content?from=${future}`);
    assert.deepEqual(empty.body.entries, []);

    const csv = await admin.get('/api/admin/audit/content/export');
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-disposition'], /content-activity\.csv/);
    assert.match(csv.text, /^id,at,action,actor,entity,entityId,ip,meta/);

    const json = await admin.get('/api/admin/audit/content/export?format=json');
    assert.ok(json.body.entries.length);
    assert.ok(
      json.body.entries.every(
        (e) => !e.action.startsWith('auth.') && !e.action.startsWith('settings.'),
      ),
    );
  });
});
