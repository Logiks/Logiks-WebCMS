import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, signedIn, ADMIN } from './helpers.js';
import {
  diffSchema,
  diffLibraries,
  buildSteps,
  renderMarkdown,
} from '../src/modules/deploy/release.js';

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
const actor = { id: 1, email: ADMIN.email };

test('the diffs name what was added, removed and changed, and removals become optional steps', () => {
  const col = (name, type = 'varchar') => ({ name, type });
  const prev = {
    a: { columns: [col('id'), col('old'), col('n', 'int')] },
    gone: { columns: [col('id')] },
  };
  const next = {
    a: { columns: [col('id'), col('new'), col('n', 'bigint')] },
    fresh: { columns: [col('id')] },
  };
  const s = diffSchema(prev, next);
  assert.deepEqual(s.tablesAdded, ['fresh']);
  assert.deepEqual(s.tablesRemoved, ['gone']);
  assert.deepEqual(s.columnsAdded, ['a.new']);
  assert.deepEqual(s.columnsRemoved, ['a.old']);
  assert.deepEqual(s.typeChanged, [{ column: 'a.n', from: 'int', to: 'bigint' }]);
  assert.equal(diffSchema(null, next), null, 'an older deploy has no structure to compare');

  const libs = diffLibraries(
    [
      { name: 'aos', version: '2.0.0', include: ['a.js'], autoload: true },
      { name: 'old', version: '1.0.0', include: [], autoload: false },
    ],
    [
      { name: 'aos', version: '3.0.0', include: ['a.js', 'a.css'], autoload: true },
      { name: 'new', version: '1.0.0', include: ['n.js'], autoload: false },
    ],
  );
  assert.deepEqual(libs.removed, ['old']);
  assert.equal(libs.added[0].name, 'new');
  assert.equal(libs.updated[0].to.version, '3.0.0');

  const steps = buildSteps({
    schema: s,
    libraries: libs,
    plugins: { removed: ['weather'], added: [] },
    migrations: [
      { file: 'm2.js', destructive: ['drops column x'] },
      { file: 'm3.js', destructive: [] },
    ],
  });
  assert.deepEqual(
    steps.map((x) => x.id),
    [
      'drop-table:gone',
      'drop-column:a.old',
      'retype-column:a.n',
      'remove-library:old',
      'remove-plugin:weather',
      'review-migration:m2.js',
    ],
  );
  assert.match(
    steps[0].detail,
    /nothing was dropped.*renamed on dev.*fresh/s,
    'a possible rename is explained',
  );
  assert.match(steps[5].detail, /Allow updates that remove or rename/);
  assert.match(
    renderMarkdown([
      {
        seq: 1,
        title: 'T',
        notes: 'n',
        createdAt: 0,
        summary: {
          files: {
            pages: { count: 1 },
            components: { count: 0 },
            themes: { count: 0 },
            plugins: { count: 0 },
            migrations: { count: 0 },
            codeFiles: 0,
          },
        },
        changes: { schema: s, libraries: libs, settings: [] },
        commits: [],
        steps,
      },
    ]),
    /- \[ \] Table “gone” no longer exists on dev/,
  );
});

test('a deploy writes release notes into the repository, keeps earlier ones, and lists what a person may want to remove by hand', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-rel-'));
  const app = path.join(root, 'app');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(path.join(app, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"project"}');
  fs.writeFileSync(
    path.join(app, 'migrations/20270101000001_ok.js'),
    'export async function up() {}\nexport async function down() {}\n',
  );
  git(root, 'init', '--bare', origin);
  const clone = () => {
    const d = fs.mkdtempSync(path.join(root, 'check-'));
    git(root, 'clone', origin, d);
    return d;
  };
  const dev = await startNode({ seed: true, appRoot: app });
  let prod;
  try {
    await dev.ctx.settings.update('deploy', { values: { repo_url: origin, branch: 'main' } });
    const deploy = async (body) => {
      const run = await dev.ctx.deploy.start({ data: true, media: false, ...body }, actor);
      await dev.ctx.deploy.idle();
      const row = (await dev.ctx.deploy.overview()).runs.find((r) => r.id === run.id);
      assert.equal(row.status, 'done', row.message);
    };
    const t0 = Date.now();
    await dev.ctx.db.schema.createTable('data_old', (t) => {
      t.integer('id').primary();
      t.string('title');
    });
    await dev.ctx.db('libraries').insert({
      name: 'aos',
      version: '2.3.4',
      integrity: 'sha512-x',
      tarball: 'AAAA',
      size: 4,
      unpacked_size: 4,
      files: '[]',
      include: '["dist/aos.js"]',
      autoload: true,
      position: 0,
      installed_at: t0,
      updated_at: t0,
    });

    await deploy({ title: 'First go-live', notes: 'Run the smoke test after updating.' });
    const one = clone();
    assert.ok(fs.existsSync(path.join(one, 'deploy-notes/releases/0001.json')));
    const r1 = JSON.parse(
      fs.readFileSync(path.join(one, 'deploy-notes/releases/0001.json'), 'utf8'),
    );
    assert.equal(r1.seq, 1);
    assert.equal(r1.title, 'First go-live');
    assert.equal(r1.notes, 'Run the smoke test after updating.');
    assert.equal(r1.by, ADMIN.email);
    assert.deepEqual(r1.steps, [], 'nothing to remove the first time');
    assert.match(
      fs.readFileSync(path.join(one, 'deploy-notes/CHANGELOG.md'), 'utf8'),
      /1\. First go-live/,
    );
    assert.equal((await dev.ctx.deployReleases.list()).length, 1, 'dev keeps its own notes too');

    // Dev removes a table and a library, adds a table, and adds a migration that drops a column.
    await dev.ctx.db.schema.dropTable('data_old');
    await dev.ctx.db.schema.createTable('data_new', (t) => {
      t.integer('id').primary();
    });
    await dev.ctx.db('libraries').where({ name: 'aos' }).del();
    fs.writeFileSync(
      path.join(app, 'migrations/20270102000001_slim.js'),
      "export async function up(knex) { await knex.schema.alterTable('entries', (t) => { t.dropColumn('seo'); }); }\nexport async function down() {}\n",
    );
    await deploy({ title: 'Cleanup', notes: '' });

    const two = clone();
    const files = fs.readdirSync(path.join(two, 'deploy-notes/releases')).sort();
    assert.deepEqual(files, ['0001.json', '0002.json'], 'the earlier note is kept');
    const r2 = JSON.parse(
      fs.readFileSync(path.join(two, 'deploy-notes/releases/0002.json'), 'utf8'),
    );
    assert.deepEqual(r2.changes.schema.tablesRemoved, ['data_old']);
    assert.ok(r2.changes.schema.tablesAdded.includes('data_new'));
    assert.deepEqual(r2.changes.libraries.removed, ['aos']);
    assert.equal(r2.changes.migrations[0].file, '20270102000001_slim.js');
    assert.deepEqual(r2.steps.map((s) => s.id).sort(), [
      'drop-table:data_old',
      'remove-library:aos',
      'review-migration:20270102000001_slim.js',
    ]);
    const md = fs.readFileSync(path.join(two, 'deploy-notes/CHANGELOG.md'), 'utf8');
    assert.ok(md.indexOf('2. Cleanup') < md.indexOf('1. First go-live'), 'newest first');
    assert.match(md, /Table “data_old” no longer exists on dev/);

    // A server that pulls it stores the notes, can read them later, and ticks steps off as it does them.
    prod = await startNode({ seed: true });
    await prod.ctx.db.schema.createTable('data_old', (t) => {
      t.integer('id').primary();
    });
    const result = { added: 3, updated: 1, conflicts: 0, removedOnDev: {}, problems: 0 };
    for (const f of files)
      await prod.ctx.deployReleases.store(
        JSON.parse(fs.readFileSync(path.join(two, 'deploy-notes/releases', f), 'utf8')),
        {
          source: 'deploy',
          result: f === '0002.json' ? result : null,
        },
      );
    await prod.ctx.deployReleases.store(r2, { source: 'deploy' }); // storing again changes nothing
    const list = await prod.ctx.deployReleases.list();
    assert.deepEqual(
      list.map((r) => [r.seq, r.unread]),
      [
        [2, true],
        [1, true],
      ],
    );
    assert.equal(await prod.ctx.deployReleases.unread(), 2);

    const admin = await signedIn(prod.app);
    const got = (await admin.get(`/api/admin/deploy/releases/${list[0].id}`)).body;
    assert.equal(got.result.added, 3);
    const drop = got.release.steps.find((s) => s.id === 'drop-table:data_old');
    assert.equal(drop.stillHere, true, 'it shows the table is still on this server');
    assert.equal(drop.done, false);
    assert.equal(got.release.steps.find((s) => s.id === 'remove-library:aos').stillHere, false);

    assert.equal(
      (
        await admin
          .put(`/api/admin/deploy/releases/${list[0].id}/steps`)
          .send({ step: 'drop-table:data_old', done: true })
      ).status,
      200,
    );
    assert.equal(
      (
        await admin
          .put(`/api/admin/deploy/releases/${list[0].id}/steps`)
          .send({ step: 'nope', done: true })
      ).status,
      422,
    );
    assert.equal(
      (await admin.get(`/api/admin/deploy/releases/${list[0].id}`)).body.release.steps.find(
        (s) => s.id === 'drop-table:data_old',
      ).done,
      true,
    );
    await admin.post(`/api/admin/deploy/releases/${list[0].id}/read`);
    assert.equal(await prod.ctx.deployReleases.unread(), 1);
    assert.equal((await admin.get('/api/admin/deploy/releases')).body.unread, 1);
    assert.equal((await admin.get('/api/admin/deploy/releases/99999')).status, 404);
  } finally {
    await prod?.close();
    await dev.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
