import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, signedIn, ADMIN } from './helpers.js';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: 'pipe' },
  ).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-sync-'));
  const app = path.join(root, 'app');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"project"}');
  fs.writeFileSync(path.join(app, 'src/a.js'), '// code');
  git(root, 'init', '--bare', origin);
  return {
    app,
    origin,
    clone: () => {
      const dir = fs.mkdtempSync(path.join(root, 'check-'));
      git(root, 'clone', origin, dir);
      return dir;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const actor = { id: 1, email: ADMIN.email };

async function devNode(fx) {
  const node = await startNode({ seed: true, appRoot: fx.app });
  await node.ctx.settings.update('deploy', { values: { repo_url: fx.origin, branch: 'main' } });
  return node;
}
async function deployFrom(dev, fx, tables = {}, settings) {
  const sel = { tables, ...(settings ? { settings } : {}) };
  await dev.ctx.deploySync.saveSelection(sel, actor);
  const run = await dev.ctx.deploy.start({ data: true, media: false }, actor);
  await dev.ctx.deploy.idle();
  const row = (await dev.ctx.deploy.overview()).runs.find((r) => r.id === run.id);
  assert.equal(row.status, 'done', row.message);
  return fx.clone(); // a checkout of what was pushed
}
const bring = (prod, clone) =>
  prod.ctx.deploySync.importFrom(path.join(clone, 'deploy-data'), actor, 'abc');

test('the default choice: what you built syncs, your own tables and media add, content, people and plugin tables stay home', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  try {
    await dev.ctx.db.schema.createTable('acme_log', (t) => {
      t.increments('id');
      t.string('line');
    });
    await dev.ctx.db.schema.createTable('data_notes', (t) => {
      t.increments('id');
      t.string('title');
    });
    const sel = await dev.ctx.deploySync.selection();
    assert.equal(sel.tables.menus, 'sync');
    assert.equal(sel.tables.libraries, 'sync');
    assert.equal(sel.tables.data_notes, 'add');
    assert.equal(sel.tables.media, 'add');
    for (const t of ['entries', 'terms', 'users', 'roles', 'acme_log'])
      assert.equal(sel.tables[t], 'skip', `${t} is off by default`);
    const view = await dev.ctx.deploySync.overview();
    assert.equal(view.tables.find((t) => t.table === 'acme_log').group, 'plugins');
    assert.deepEqual(view.tables.find((t) => t.table === 'acme_log').modes, ['skip', 'add']);
    assert.ok(!view.tables.some((t) => ['sessions', 'audit_logs', 'api_keys'].includes(t.table)));
    assert.ok(sel.settings.includes('site.theme') && sel.settings.includes('mail.host'));
    assert.ok(
      !sel.settings.some((s) => /^(updates|deploy)\./.test(s)),
      'the deploy plumbing stays',
    );
    assert.ok(!sel.settings.includes('mail.password'), 'no secret is ever chosen');
    assert.ok(
      view.secretKeys.some((k) => k.id === 'mail.password'),
      'secrets are listed as never copied',
    );
    assert.ok(!view.settings.flatMap((n) => n.fields).some((f) => f.id === 'mail.password'));

    await dev.ctx.db('acme_log').insert({ line: 'x' });
    const clone = await deployFrom(dev, fx);
    assert.ok(fs.existsSync(path.join(clone, 'deploy-data/db/menus.ndjson')));
    assert.ok(
      !fs.existsSync(path.join(clone, 'deploy-data/db/acme_log.ndjson')),
      'plugin data is not pushed',
    );
    assert.ok(
      !fs.existsSync(path.join(clone, 'deploy-data/db/users.ndjson')),
      'users are not pushed',
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(clone, 'deploy-data/manifest.json'), 'utf8'),
    );
    assert.ok(manifest.schema.acme_log, 'the table structure of every table still travels');
  } finally {
    await dev.close();
    fx.cleanup();
  }
});

test('a child cannot be chosen without its parents', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  try {
    const sel = await dev.ctx.deploySync.saveSelection(
      { tables: { entry_terms: 'sync', users: 'add' } },
      actor,
    );
    assert.notEqual(sel.tables.entries, 'skip');
    assert.notEqual(sel.tables.terms, 'skip');
    assert.notEqual(sel.tables.roles, 'skip');
    const again = await dev.ctx.deploySync.selection();
    assert.deepEqual(again, sel, 'the choice is saved and read back');
    const bad = await dev.ctx.deploySync.saveSelection(
      { tables: { menus: 'sync', nope: 'sync', users: 'zzz' } },
      actor,
    );
    assert.equal(bad.tables.nope, undefined);
    assert.equal(bad.tables.users, 'skip');
  } finally {
    await dev.close();
    fx.cleanup();
  }
});

test('sync: new records arrive, an unchanged-here record is updated, a record edited here is a conflict, nothing is deleted', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    const t0 = Date.now();
    await dev.ctx.db('menus').insert([
      { name: 'main', title: 'Main', items: '[{"label":"Home"}]', updated_at: t0 },
      { name: 'footer', title: 'Footer', items: '[]', updated_at: t0 },
    ]);
    await dev.ctx
      .db('redirects')
      .insert({ from_path: '/old', to_url: '/new', status_code: 301, created_at: t0 });
    const first = await deployFrom(dev, fx);

    prod = await startNode({ seed: true });
    await prod.ctx
      .db('menus')
      .insert({ name: 'prod-only', title: 'Mine', items: '[]', updated_at: t0 });
    const r1 = await bring(prod, first);
    assert.equal(r1.problems.length, 0, r1.problems.join('; '));
    assert.equal(r1.tables.menus.added, 2);
    assert.deepEqual(
      (await prod.ctx.db('menus').orderBy('name')).map((m) => m.name),
      ['footer', 'main', 'prod-only'],
    );
    assert.equal((await prod.ctx.db('redirects').first()).to_url, '/new');

    // Dev changes a menu and a redirect, deletes the footer menu; prod edits the redirect itself.
    await dev.ctx.db('menus').where({ name: 'main' }).update({ items: '[{"label":"Start"}]' });
    await dev.ctx.db('menus').where({ name: 'footer' }).del();
    await dev.ctx.db('redirects').where({ from_path: '/old' }).update({ to_url: '/dev-new' });
    await prod.ctx.db('redirects').where({ from_path: '/old' }).update({ to_url: '/prod-new' });
    const second = await deployFrom(dev, fx);
    const r2 = await bring(prod, second);
    assert.equal(r2.problems.length, 0, r2.problems.join('; '));

    assert.equal(
      (await prod.ctx.db('menus').where({ name: 'main' }).first()).items,
      '[{"label":"Start"}]',
      'untouched here → updated',
    );
    assert.ok(
      await prod.ctx.db('menus').where({ name: 'footer' }).first(),
      'a record deleted on dev is never deleted here',
    );
    assert.equal(r2.removedOnDev.menus.count, 1);
    assert.match(r2.removedOnDev.menus.examples[0], /footer/);
    assert.equal(
      (await prod.ctx.db('redirects').first()).to_url,
      '/prod-new',
      'edited here → kept',
    );
    assert.equal(r2.conflicts, 1);

    const open = await prod.ctx.deploySync.listConflicts();
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].changes[0], {
      column: 'to_url',
      current: '/prod-new',
      incoming: '/dev-new',
    });

    // Importing the same deployment again neither duplicates the conflict nor applies anything.
    await bring(prod, second);
    assert.equal((await prod.ctx.deploySync.listConflicts()).length, 1);
    assert.equal((await prod.ctx.db('redirects').first()).to_url, '/prod-new');

    // Ticking it applies dev's version.
    const done = await prod.ctx.deploySync.applyConflicts([open[0].id], actor);
    assert.equal(done.applied, 1);
    assert.equal((await prod.ctx.db('redirects').first()).to_url, '/dev-new');
    assert.equal((await prod.ctx.deploySync.listConflicts()).length, 0);
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test("a dismissed conflict keeps this server's version and is not raised again until dev changes it again", async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    const t0 = Date.now();
    await dev.ctx
      .db('redirects')
      .insert({ from_path: '/a', to_url: '/dev1', status_code: 301, created_at: t0 });
    const first = await deployFrom(dev, fx);
    prod = await startNode({ seed: true });
    await bring(prod, first);
    await prod.ctx.db('redirects').update({ to_url: '/prod' });
    await dev.ctx.db('redirects').update({ to_url: '/dev2' });
    const second = await deployFrom(dev, fx);
    await bring(prod, second);
    const [c] = await prod.ctx.deploySync.listConflicts();
    await prod.ctx.deploySync.dismissConflicts([c.id], actor);
    await bring(prod, second);
    assert.equal(
      (await prod.ctx.deploySync.listConflicts()).length,
      0,
      'the same dev version is not raised again',
    );
    assert.equal((await prod.ctx.db('redirects').first()).to_url, '/prod');
    await dev.ctx.db('redirects').update({ to_url: '/dev3' });
    await bring(prod, await deployFrom(dev, fx));
    assert.equal(
      (await prod.ctx.deploySync.listConflicts()).length,
      1,
      'a later change from dev is',
    );
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test('content is matched by slug, not id: parents, categories and revisions land on the right records even when ids differ', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    const t0 = Date.now();
    const entry = (o) => ({
      type: 'post',
      locale: 'en',
      title: o.slug,
      status: 'published',
      position: 0,
      data: '{}',
      version: 1,
      path: `/${o.slug}`,
      created_at: t0,
      updated_at: t0,
      ...o,
    });
    await dev.ctx
      .db('terms')
      .insert({ taxonomy: 'category', slug: 'news', name: 'News', created_at: t0 });
    await dev.ctx.db('entries').insert(entry({ slug: 'parent' }));
    const parent = await dev.ctx.db('entries').where({ slug: 'parent' }).first();
    await dev.ctx.db('entries').insert(entry({ slug: 'child', parent_id: parent.id }));
    const child = await dev.ctx.db('entries').where({ slug: 'child' }).first();
    const term = await dev.ctx.db('terms').first();
    await dev.ctx.db('entry_terms').insert({ entry_id: child.id, term_id: term.id });
    await dev.ctx.db('entry_revisions').insert({
      entry_id: child.id,
      version: 1,
      title: 'child',
      slug: 'child',
      status: 'published',
      data: '{}',
      created_at: t0,
    });

    const clone = await deployFrom(dev, fx, {
      entries: 'sync',
      terms: 'sync',
      entry_terms: 'sync',
      entry_revisions: 'sync',
    });
    prod = await startNode({ seed: true });
    // Prod already has its own entries, so the ids do not line up.
    await prod.ctx.db('entries').insert([entry({ slug: 'prod-a' }), entry({ slug: 'prod-b' })]);
    const r = await bring(prod, clone);
    assert.equal(r.problems.length, 0, r.problems.join('; '));
    const p = await prod.ctx.db('entries').where({ slug: 'parent' }).first();
    const c = await prod.ctx.db('entries').where({ slug: 'child' }).first();
    assert.notEqual(Number(p.id), Number(parent.id), 'a different id here');
    assert.equal(Number(c.parent_id), Number(p.id), 'the parent link follows the slug');
    const links = await prod.ctx.db('entry_terms');
    assert.equal(links.length, 1);
    assert.equal(Number(links[0].entry_id), Number(c.id));
    assert.equal((await prod.ctx.db('terms').where({ id: links[0].term_id }).first()).slug, 'news');
    assert.equal(Number((await prod.ctx.db('entry_revisions').first()).entry_id), Number(c.id));
    assert.equal((await prod.ctx.db('entries')).length, 4, 'prod keeps its own two');
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test('users: matched by email, role translated; an existing user whose password differs is a conflict, never overwritten', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    const role = await dev.ctx.db('roles').first();
    await dev.ctx.db('users').insert({
      email: 'writer@example.com',
      name: 'Writer',
      password_hash: 'dev-hash',
      role_id: role.id,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const clone = await deployFrom(dev, fx, { users: 'sync', roles: 'sync' });
    prod = await startNode({ seed: true });
    const before = await prod.ctx.db('users').where({ email: ADMIN.email }).first();
    const r = await bring(prod, clone);
    assert.equal(r.problems.length, 0, r.problems.join('; '));
    const w = await prod.ctx.db('users').where({ email: 'writer@example.com' }).first();
    assert.ok(w, 'the new user arrived');
    assert.equal((await prod.ctx.db('roles').where({ id: w.role_id }).first()).name, role.name);
    const after = await prod.ctx.db('users').where({ email: ADMIN.email }).first();
    assert.equal(
      after.password_hash,
      before.password_hash,
      'the existing admin is never overwritten',
    );
    assert.ok(
      (await prod.ctx.deploySync.listConflicts()).some((c) => c.label.includes(ADMIN.email)),
    );
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test('settings: chosen keys are carried, a theme this server lacks is refused, and a key changed here is a conflict', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    await dev.ctx.settings.update('seo', { values: { twitter_site: '@dev' } }, actor);
    await dev.ctx.settings.update('general', { values: { site_name: 'Dev name' } }, actor);
    const clone = await deployFrom(dev, fx, {}, [
      'seo.twitter_site',
      'general.tagline',
      'site.theme',
      'general.site_name',
    ]);
    const plan = JSON.parse(fs.readFileSync(path.join(clone, 'deploy-data/sync.json'), 'utf8'));
    assert.deepEqual(plan.settings.map((s) => s.id).sort(), [
      'general.site_name',
      'general.tagline',
      'seo.twitter_site',
      'site.theme',
    ]);
    assert.ok(!JSON.stringify(plan).includes('anthropic'), 'no secret setting is in the plan');

    prod = await startNode({ seed: true });
    await prod.ctx.settings.update('general', { values: { site_name: 'Prod name' } }, actor);
    const r = await bring(prod, clone);
    assert.equal(prod.ctx.settings.get('seo.twitter_site'), '@dev');
    assert.equal(
      prod.ctx.settings.get('general.site_name'),
      'Prod name',
      'edited here → not overwritten',
    );
    assert.equal(r.conflicts, 1);
    const [c] = await prod.ctx.deploySync.listConflicts();
    assert.equal(c.label, 'setting: general.site_name');
    await prod.ctx.deploySync.applyConflicts([c.id], actor);
    assert.equal(prod.ctx.settings.get('general.site_name'), 'Dev name');

    // A theme this server does not have is not switched to.
    await dev.ctx.themes.duplicate('default', { newId: 'mine', name: 'Mine' }, null);
    await dev.ctx.settings.update('site', { values: { theme: 'mine' } }, actor);
    const second = await deployFrom(dev, fx, {}, ['site.theme']);
    const r2 = await bring(prod, second);
    assert.equal(prod.ctx.settings.get('site.theme'), 'default');
    assert.ok(
      r2.problems.some((p) => /theme "mine" is not installed here/.test(p)),
      r2.problems.join('; '),
    );
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test('plugin tables: off by default; when added, records come only where the key is free and the table exists', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    const make = (n) =>
      n.ctx.db.schema.createTable('acme_log', (t) => {
        t.integer('id').primary();
        t.string('line');
      });
    await make(dev);
    await dev.ctx.db('acme_log').insert([
      { id: 1, line: 'dev one' },
      { id: 2, line: 'dev two' },
    ]);
    const clone = await deployFrom(dev, fx, { acme_log: 'add' });
    prod = await startNode({ seed: true });
    const none = await bring(prod, clone);
    assert.ok(none.problems.some((p) => /acme_log: this server does not have the table/.test(p)));
    await make(prod);
    await prod.ctx.db('acme_log').insert({ id: 2, line: 'prod two' });
    const r = await bring(prod, clone);
    assert.equal(r.tables.acme_log.added, 1);
    assert.deepEqual(
      (await prod.ctx.db('acme_log').orderBy('id')).map((x) => x.line),
      ['dev one', 'prod two'],
    );
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test('the admin API: read the choice, change it, review and tick conflicts; each needs its permission', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  try {
    const admin = await signedIn(dev.app);
    const got = await admin.get('/api/admin/deploy/data');
    assert.equal(got.status, 200);
    assert.ok(got.body.groups.length && got.body.tables.length && got.body.settings.length);
    const put = await admin
      .put('/api/admin/deploy/data')
      .send({ tables: { menus: 'skip' }, settings: ['seo.twitter_site'] });
    assert.equal(put.status, 200);
    assert.equal(put.body.tables.find((t) => t.table === 'menus').mode, 'skip');
    assert.equal(
      put.body.settings
        .find((s) => s.namespace === 'seo')
        .fields.find((f) => f.id === 'seo.twitter_site').selected,
      true,
    );
    assert.equal(
      (await admin.put('/api/admin/deploy/data').send({ tables: { menus: 'wild' } })).status,
      422,
    );
    assert.equal((await admin.get('/api/admin/deploy/conflicts')).body.conflicts.length, 0);
    assert.equal(
      (await admin.post('/api/admin/deploy/conflicts/apply').send({ ids: [] })).status,
      422,
    );
  } finally {
    await dev.close();
    fx.cleanup();
  }
});

test('a large content table syncs in chunks: 4,000 entries arrive, a repeat changes nothing, one edit on dev updates exactly one', async () => {
  const fx = fixture();
  const dev = await devNode(fx);
  let prod;
  try {
    const t0 = Date.now();
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      type: 'post',
      locale: 'en',
      slug: `post-${i}`,
      path: `/post-${i}`,
      title: `Post ${i}`,
      status: 'published',
      position: 0,
      data: '{"body":"text"}',
      version: 1,
      created_at: t0,
      updated_at: t0,
    }));
    await dev.ctx.db.batchInsert('entries', rows, 100);
    const clone = await deployFrom(dev, fx, { entries: 'sync' });
    prod = await startNode({ seed: true });
    await prod.ctx.db('entries').insert({ ...rows[0], slug: 'prod-own', path: '/prod-own' });

    const started = Date.now();
    const r = await bring(prod, clone);
    assert.equal(r.problems.length, 0, r.problems.join('; '));
    assert.equal(r.tables.entries.added, 4000);
    assert.equal(Number((await prod.ctx.db('entries').count({ n: '*' }))[0].n), 4001);
    assert.ok(Date.now() - started < 60000, `took ${Date.now() - started} ms`);

    const again = await bring(prod, clone);
    assert.deepEqual(
      [again.tables.entries.added, again.tables.entries.updated, again.conflicts],
      [0, 0, 0],
      'a repeat changes nothing',
    );
    await dev.ctx.db('entries').where({ slug: 'post-7' }).update({ title: 'Seven, edited' });
    const next = await bring(prod, await deployFrom(dev, fx, { entries: 'sync' }));
    assert.equal(next.tables.entries.updated, 1);
    assert.equal(
      (await prod.ctx.db('entries').where({ slug: 'post-7' }).first()).title,
      'Seven, edited',
    );
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});
