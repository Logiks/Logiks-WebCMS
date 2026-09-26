import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn, sleep } from './helpers.js';

let node, admin;
const PW = 'Some-long-pass-12';
const blocks = (...texts) => ({
  blocks: texts.map((text) => ({ type: 'paragraph', data: { text } })),
});
const page = (title, extra = {}) => ({ title, data: { body: blocks(`About ${title}`) }, ...extra });

async function userWith(name, permissions) {
  const role = await node.ctx.users.createRole({ name, permissions }, null);
  const email = `${name.toLowerCase().replace(/\W+/g, '')}@example.com`;
  await node.ctx.users.createUser({ email, name, password: PW, roleId: Number(role.id) }, null);
  return signedIn(node.app, { email, password: PW });
}

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

test('pages and posts are declared types with their own fields, and unknown fields are dropped', async () => {
  const types = (await admin.get('/api/admin/content/types')).body.types;
  assert.deepEqual(
    types.map((t) => t.id),
    ['page', 'post'],
  );
  assert.ok(types[0].fields.some((f) => f.key === 'body' && f.type === 'blocks'));
  assert.deepEqual(
    types[1].taxonomies.map((t) => t.id),
    ['category', 'tag'],
  );

  const res = await admin.post('/api/admin/content/types/page/entries').send({
    title: 'About us',
    data: {
      excerpt: 'Who we are',
      bogus: 'dropped',
      seo_title: 'About | Site',
      body: blocks('Hello'),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const e = res.body.entry;
  assert.equal(e.slug, 'about-us');
  assert.equal(e.path, 'about-us');
  assert.equal(e.status, 'draft');
  assert.equal(e.data.excerpt, 'Who we are');
  assert.equal('bogus' in e.data, false);
  assert.equal(e.data.body.blocks[0].data.text, 'Hello');
  assert.equal(e.version, 1);
});

test('addresses: generated ones are made unique, explicit clashes are refused, reserved ones are blocked', async () => {
  const a = (await admin.post('/api/admin/content/types/page/entries').send(page('Pricing'))).body
    .entry;
  const b = (await admin.post('/api/admin/content/types/page/entries').send(page('Pricing'))).body
    .entry;
  assert.equal(a.slug, 'pricing');
  assert.equal(b.slug, 'pricing-2');

  const clash = await admin
    .post('/api/admin/content/types/page/entries')
    .send(page('Other', { slug: 'pricing' }));
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.field, 'slug');

  for (const slug of ['admin', 'api', 'sitemap.xml', 'blog']) {
    const r = await admin.post('/api/admin/content/types/page/entries').send(page('X', { slug }));
    assert.equal(r.status, 422, slug);
  }
  const auto = (await admin.post('/api/admin/content/types/page/entries').send(page('Admin'))).body
    .entry;
  assert.equal(auto.slug, 'admin-2', 'a generated address steps around reserved names');
  assert.equal(
    (
      await admin
        .post('/api/admin/content/types/page/entries')
        .send(page('Bad', { slug: 'Not A Slug' }))
    ).status,
    422,
  );
  assert.equal(
    (await admin.post('/api/admin/content/types/page/entries').send({ title: '   ' })).status,
    422,
  );
});

test("field values are validated with the type's field rules", async () => {
  const r = await admin
    .post('/api/admin/content/types/page/entries')
    .send({ title: 'T', data: { excerpt: 'x'.repeat(501) } });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /^Summary:/);
  assert.equal(r.body.error.field, 'data.excerpt');
  const m = await admin
    .post('/api/admin/content/types/page/entries')
    .send({ title: 'T', data: { featured_image: 'abc' } });
  assert.equal(m.status, 422);
});

test("hierarchy: children get their parent's path, moving a page moves its descendants, cycles and orphaning deletes are refused", async () => {
  const mk = async (title, parentId) =>
    (await admin.post('/api/admin/content/types/page/entries').send(page(title, { parentId }))).body
      .entry;
  const company = await mk('Company');
  const team = await mk('Team', company.id);
  const bios = await mk('Bios', team.id);
  assert.equal(team.path, 'company/team');
  assert.equal(bios.path, 'company/team/bios');

  const renamed = await admin
    .put(`/api/admin/content/entries/${company.id}`)
    .send({ slug: 'about-company' });
  assert.equal(renamed.body.entry.path, 'about-company');
  assert.equal(
    (await admin.get(`/api/admin/content/entries/${bios.id}`)).body.entry.path,
    'about-company/team/bios',
  );

  const other = await mk('Careers');
  await admin.put(`/api/admin/content/entries/${team.id}`).send({ parentId: other.id });
  assert.equal(
    (await admin.get(`/api/admin/content/entries/${bios.id}`)).body.entry.path,
    'careers/team/bios',
  );

  const cycle = await admin
    .put(`/api/admin/content/entries/${other.id}`)
    .send({ parentId: bios.id });
  assert.equal(cycle.status, 422);
  assert.match(cycle.body.error.message, /under itself/);
  assert.equal((await admin.delete(`/api/admin/content/entries/${other.id}`)).status, 409);
  assert.equal((await admin.delete(`/api/admin/content/entries/${bios.id}`)).status, 204);
});

test('every save is a revision; restoring one is a new revision; old ones are pruned; a stale save is a conflict', async () => {
  const e = (await admin.post('/api/admin/content/types/page/entries').send(page('History'))).body
    .entry;
  const v2 = (
    await admin
      .put(`/api/admin/content/entries/${e.id}`)
      .send({ title: 'History 2', version: 1, data: { excerpt: 'second' } })
  ).body.entry;
  assert.equal(v2.version, 2);

  const stale = await admin
    .put(`/api/admin/content/entries/${e.id}`)
    .send({ title: 'Mine', version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.currentVersion, 2);

  const revs = (await admin.get(`/api/admin/content/entries/${e.id}/revisions`)).body.revisions;
  assert.deepEqual(
    revs.map((r) => r.version),
    [2, 1],
  );
  const restored = (
    await admin.post(`/api/admin/content/entries/${e.id}/revisions/${revs[1].id}/restore`).send({})
  ).body.entry;
  assert.equal(restored.title, 'History');
  assert.equal(restored.data.excerpt, '');
  assert.equal(restored.version, 3);
  assert.match(
    (await admin.get(`/api/admin/content/entries/${e.id}/revisions`)).body.revisions[0].note,
    /Restored version 1/,
  );
  const restoreEntry = (await node.ctx.audit.list({ action: 'content.update', limit: 5 })).find(
    (a) => a.entityId === String(e.id) && a.meta?.note,
  );
  assert.match(
    restoreEntry.meta.note,
    /Restored version 1/,
    'a restore is distinguishable in the audit trail, not just a plain update',
  );

  await node.ctx.settings.update('content', { values: { max_revisions: 2 } });
  await admin.put(`/api/admin/content/entries/${e.id}`).send({ title: 'History 4' });
  await admin.put(`/api/admin/content/entries/${e.id}`).send({ title: 'History 5' });
  assert.equal(
    (await admin.get(`/api/admin/content/entries/${e.id}/revisions`)).body.revisions.length,
    2,
  );
  await node.ctx.settings.update('content', { reset: ['max_revisions'] });
});

test('publishing, scheduling and archiving change the status, are audited, and a scheduled entry goes live by itself', async () => {
  const e = (await admin.post('/api/admin/content/types/post/entries').send(page('Launch'))).body
    .entry;
  const pub = (await admin.put(`/api/admin/content/entries/${e.id}`).send({ status: 'published' }))
    .body.entry;
  assert.equal(pub.status, 'published');
  assert.ok(pub.publishedAt);

  const past = await admin
    .put(`/api/admin/content/entries/${e.id}`)
    .send({ status: 'scheduled', publishAt: Date.now() - 1000 });
  assert.equal(past.status, 422);
  assert.equal(past.body.error.field, 'publishAt');

  const s = (
    await admin
      .post('/api/admin/content/types/post/entries')
      .send(page('Later', { status: 'scheduled', publishAt: Date.now() + 120 }))
  ).body.entry;
  assert.equal(s.status, 'scheduled');
  assert.equal(await node.ctx.content.publishDue(), 0, 'not due yet');
  await sleep(200);
  const runs = await Promise.all([node.ctx.content.publishDue(), node.ctx.content.publishDue()]);
  assert.equal(runs[0] + runs[1], 1, 'two schedulers racing publish it once');
  const live = (await admin.get(`/api/admin/content/entries/${s.id}`)).body.entry;
  assert.equal(live.status, 'published');
  assert.equal(live.publishAt, null);

  assert.equal(
    (await admin.put(`/api/admin/content/entries/${e.id}`).send({ status: 'archived' })).body.entry
      .status,
    'archived',
  );
  const d = (
    await admin.post('/api/admin/content/types/post/entries').send(page('Draft to schedule'))
  ).body.entry;
  const sched = await admin
    .put(`/api/admin/content/entries/${d.id}`)
    .send({ status: 'scheduled', publishAt: Date.now() + 3600_000 });
  assert.equal(sched.body.entry.status, 'scheduled');
  const actions = (await node.ctx.audit.list({ action: 'content.', limit: 50 })).map(
    (a) => a.action,
  );
  for (const a of ['content.create', 'content.publish', 'content.schedule', 'content.archive'])
    assert.ok(actions.includes(a), a);
  assert.equal(
    (await admin.put(`/api/admin/content/entries/${e.id}`).send({ status: 'nonsense' })).status,
    422,
  );
});

test('the scheduler job is registered', async () => {
  assert.ok((await node.ctx.jobs.stats()).scheduled.some((j) => j.name === 'content.publish_due'));
});

test('permissions are per type and per action: an author drafts, an editor publishes, others see nothing', async () => {
  const author = await userWith('Post drafter', [
    'admin.access',
    'content.post.read',
    'content.post.write',
  ]);
  const editor = await userWith('Content lead', ['admin.access', 'content.*']);
  const nobody = await userWith('Nobody here', ['admin.access', 'settings.read']);

  assert.equal((await nobody.get('/api/admin/content/types')).status, 403);
  assert.deepEqual(
    (await author.get('/api/admin/content/types')).body.types.map((t) => t.id),
    ['post'],
    'no page permissions, no pages',
  );
  assert.equal((await author.get('/api/admin/content/types/page/entries')).status, 403);
  assert.equal(
    (await author.post('/api/admin/content/types/page/entries').send(page('Nope'))).status,
    403,
  );

  const mine = (await author.post('/api/admin/content/types/post/entries').send(page('My draft')))
    .body.entry;
  assert.equal(mine.status, 'draft');
  assert.equal(
    (await author.put(`/api/admin/content/entries/${mine.id}`).send({ title: 'My draft, edited' }))
      .status,
    200,
  );
  const tryPublish = await author
    .put(`/api/admin/content/entries/${mine.id}`)
    .send({ status: 'published' });
  assert.equal(tryPublish.status, 403);
  assert.match(tryPublish.body.error.message, /Publish/);
  assert.equal(
    (
      await author
        .post('/api/admin/content/types/post/entries')
        .send(page('Sneaky', { status: 'published' }))
    ).status,
    403,
  );

  assert.equal(
    (await editor.put(`/api/admin/content/entries/${mine.id}`).send({ status: 'published' }))
      .status,
    200,
  );
  const late = await author
    .put(`/api/admin/content/entries/${mine.id}`)
    .send({ title: 'Edit after live' });
  assert.equal(late.status, 403);
  assert.match(late.body.error.message, /already live/);

  const theirs = (
    await editor.post('/api/admin/content/types/post/entries').send(page('Editor draft'))
  ).body.entry;
  const other = await author
    .put(`/api/admin/content/entries/${theirs.id}`)
    .send({ title: 'Hijack' });
  assert.equal(other.status, 403);
  assert.match(other.body.error.message, /someone else/);
  assert.equal((await author.delete(`/api/admin/content/entries/${theirs.id}`)).status, 403);
  assert.equal((await editor.delete(`/api/admin/content/entries/${theirs.id}`)).status, 204);
});

test('categories and tags: created, attached to posts only, counted, and detached when deleted', async () => {
  const cat = (
    await admin
      .post('/api/admin/content/taxonomies/category/terms')
      .send({ name: 'News & Updates' })
  ).body.term;
  assert.equal(cat.slug, 'news-updates');
  assert.equal(
    (
      await admin
        .post('/api/admin/content/taxonomies/category/terms')
        .send({ name: 'news updates' })
    ).status,
    409,
  );
  assert.equal(
    (await admin.post('/api/admin/content/taxonomies/nope/terms').send({ name: 'x' })).status,
    404,
  );
  const tag = (
    await admin.post('/api/admin/content/taxonomies/tag/terms').send({ name: 'Release' })
  ).body.term;

  const post = (
    await admin
      .post('/api/admin/content/types/post/entries')
      .send(page('Tagged', { termIds: [cat.id, tag.id] }))
  ).body.entry;
  assert.deepEqual(post.terms.map((t) => t.slug).sort(), ['news-updates', 'release']);
  assert.equal(
    (await admin.get('/api/admin/content/taxonomies/category/terms')).body.terms.find(
      (t) => t.id === cat.id,
    ).uses,
    1,
  );
  assert.equal(
    (
      await admin
        .post('/api/admin/content/types/page/entries')
        .send(page('Paged', { termIds: [cat.id] }))
    ).status,
    422,
    'pages have no categories',
  );

  assert.equal((await admin.delete(`/api/admin/content/terms/${cat.id}`)).status, 204);
  assert.deepEqual(
    (await admin.get(`/api/admin/content/entries/${post.id}`)).body.entry.terms.map((t) => t.slug),
    ['release'],
  );
  const list = (await admin.get(`/api/admin/content/types/post/entries?termId=${tag.id}`)).body;
  assert.equal(list.total, 1);
});

test('listing filters by status and title, and pages come back in address order', async () => {
  const drafts = (await admin.get('/api/admin/content/types/post/entries?status=draft')).body;
  assert.ok(drafts.entries.every((e) => e.status === 'draft'));
  assert.equal(drafts.entries[0].data, undefined, 'lists do not carry the heavy fields');
  const q = (await admin.get('/api/admin/content/types/page/entries?q=Pric')).body;
  assert.ok(q.entries.length >= 2 && q.entries.every((e) => /Pric/.test(e.title)));
  const paths = (
    await admin.get('/api/admin/content/types/page/entries?limit=200')
  ).body.entries.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort());
});

test('saving invalidates precisely: drafts touch nothing shared, body edits touch the entry, renames also the page tree and menus', async () => {
  const bumped = async (fn, tags) => {
    const before = await node.ctx.cache.versions(tags);
    await fn();
    const after = await node.ctx.cache.versions(tags);
    return tags.filter((t) => after[t] > before[t]).sort();
  };
  const put = (id, body) => admin.put(`/api/admin/content/entries/${id}`).send(body);
  const e = (await admin.post('/api/admin/content/types/page/entries').send(page('Cached'))).body
    .entry;
  const T = [`content:${e.id}`, 'type:page', 'tree:page', 'menu', 'sitemap'];

  assert.deepEqual(
    await bumped(() => put(e.id, { title: 'Cached draft edit' }), T),
    [`content:${e.id}`],
    'a draft is invisible: only its own tag moves',
  );

  assert.deepEqual(
    await bumped(() => put(e.id, { status: 'published' }), T),
    [...T].sort(),
    'going live changes the sitemap, lists, tree and menus',
  );
  assert.deepEqual(
    await bumped(() => put(e.id, { data: { excerpt: 'only the text changed' } }), T),
    [`content:${e.id}`, 'sitemap', 'type:page'].sort(),
    'a text edit leaves the tree and menus alone',
  );
  assert.deepEqual(
    await bumped(() => put(e.id, { title: 'Cached renamed' }), T),
    [...T].sort(),
    'a rename shows in menus and breadcrumbs',
  );
  assert.deepEqual(
    await bumped(() => put(e.id, { status: 'draft' }), T),
    [...T].sort(),
    'taking it down is visible too',
  );

  const post = (await admin.post('/api/admin/content/types/post/entries').send(page('Tagged post')))
    .body.entry;
  const cat = (
    await admin.post('/api/admin/content/taxonomies/category/terms').send({ name: 'Cache cat' })
  ).body.term;
  await put(post.id, { status: 'published', termIds: [cat.id] });
  assert.ok(
    (
      await bumped(() => put(post.id, { data: { excerpt: 'x' } }), [`term:${cat.id}`, 'menu'])
    ).includes(`term:${cat.id}`),
    'category pages refresh when a post in them changes',
  );
  assert.deepEqual(
    await bumped(() => put(post.id, { data: { excerpt: 'y' } }), ['menu', 'tree:post']),
    [],
    'posts are not in the navigation',
  );
});
