import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, signedIn, until, ADMIN } from './helpers.js';
import { isExcluded, DEPLOY_GITIGNORE } from '../src/modules/deploy/service.js';

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

/** A pretend development installation (the folder the CMS runs from) and an empty bare repository to deploy to. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-dep-'));
  const app = path.join(root, 'app');
  const origin = path.join(root, 'origin.git');
  const write = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), text);
  };
  write('package.json', '{"name":"project"}');
  write('src/a.js', '// code');
  write('node_modules/dep/index.js');
  write('src/node_modules/inner/index.js');
  write('data/media/photo.jpg', 'private');
  write('data/cms.db', 'private');
  write('.env', 'APP_MASTER_KEY=secret');
  write('.env.production', 'SECRET=1');
  write('debug.log');
  write('.gitignore', 'plugins/*\npublic/\n');
  write('plugins/local-one/plugin.json', '{"slug":"local-one"}');
  write('public/pages/stale.html', 'stale mirror copy');
  write('public/.site-mirror.json', '{}');
  write('public/pages/note.html.local', 'hand kept');
  git(root, 'init', '--bare', origin);
  return {
    root,
    app,
    origin,
    write,
    clone: () => {
      const dir = fs.mkdtempSync(path.join(root, 'check-'));
      git(root, 'clone', origin, dir);
      return dir;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function nodeFor(fx, values = {}) {
  const node = await startNode({ seed: true, appRoot: fx.app });
  await node.ctx.settings.update('deploy', {
    values: { repo_url: fx.origin, branch: 'main', ...values },
  });
  return node;
}

const has = (node, p) => node.ctx.siteFiles.list().some((f) => f.path === p);
const deploy = async (node, include = {}) => {
  const run = await node.ctx.deploy.start(include, { id: 1, email: ADMIN.email });
  await node.ctx.deploy.idle();
  return (await node.ctx.deploy.overview()).runs.find((r) => r.id === run.id);
};

test('the exclusion rules: data, secrets, dependencies and per-server files stay out; plugins and public go in', () => {
  for (const p of [
    'node_modules/a/b.js',
    'plugins/x/node_modules/y.js',
    'data/media/a.jpg',
    'data',
    '.git/config',
    '.env',
    '.env.production',
    'server.log',
    'public/.site-mirror.json',
    'public/pages/a.html.local',
  ])
    assert.equal(isExcluded(p), true, p);
  for (const p of [
    'src/data/helpers.js',
    'plugins/x/plugin.json',
    'public/pages/home.html',
    'site/themes/default/theme.json',
    'package.json',
    '.gitignore',
    '.nvmrc',
  ])
    assert.equal(isExcluded(p), false, p);
  assert.doesNotMatch(DEPLOY_GITIGNORE, /^plugins|^public/m);
});

test('a deploy pushes the code, plugins and public, and never data, secrets or dependencies', async () => {
  const fx = fixture();
  const node = await nodeFor(fx);
  try {
    await node.ctx.siteFiles.put('pages/hello.html', '<h1>Hello</h1>', null);
    const run = await deploy(node);
    assert.equal(run.status, 'done', run.message);
    assert.match(run.message, /Deployed \d+ changed files? to main/);

    const out = fx.clone();
    const has = (rel) => fs.existsSync(path.join(out, rel));
    assert.ok(has('package.json') && has('src/a.js'));
    assert.ok(has('plugins/local-one/plugin.json'), 'plugins/ is deployed');
    assert.ok(has('public/pages/hello.html'), 'the site tree is written from the database');
    assert.equal(
      has('public/pages/stale.html'),
      false,
      'the stale mirror copy is replaced, not shipped',
    );
    for (const gone of [
      'node_modules',
      'src/node_modules',
      'data',
      '.env',
      '.env.production',
      'debug.log',
      'public/.site-mirror.json',
      'public/pages/note.html.local',
    ])
      assert.equal(has(gone), false, gone);
    assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), DEPLOY_GITIGNORE);
    assert.equal(git(out, 'branch', '--show-current'), 'main');
    assert.match(git(out, 'log', '-1', '--format=%s'), /^Deploy from .* by /);
    // The development folder itself is untouched.
    assert.equal(fs.existsSync(path.join(fx.app, 'data/media/photo.jpg')), true);
    assert.equal(fs.readFileSync(path.join(fx.app, '.gitignore'), 'utf8'), 'plugins/*\npublic/\n');
    assert.equal(
      fs.existsSync(path.join(os.tmpdir(), 'deploy')),
      false,
      'the temporary folder is removed',
    );

    const [entry] = await node.ctx.audit.list({ action: 'deploy.run' });
    assert.equal(entry.meta.branch, 'main');
  } finally {
    await node.close();
    fx.cleanup();
  }
});

test('deploying again adds one commit on top, carries deletions, and says so when nothing changed', async () => {
  const fx = fixture();
  const node = await nodeFor(fx);
  try {
    assert.equal((await deploy(node)).status, 'done');
    const out = fx.clone();
    const first = git(out, 'rev-parse', 'HEAD');

    const same = await deploy(node);
    assert.equal(same.status, 'done');
    assert.match(same.message, /Nothing changed/);
    assert.equal(same.commit, first);
    git(out, 'pull', '--ff-only');
    assert.equal(git(out, 'rev-parse', 'HEAD'), first, 'no empty commit');

    fx.write('src/b.js', '// new');
    fs.rmSync(path.join(fx.app, 'src/a.js'));
    assert.equal((await deploy(node)).status, 'done');
    git(out, 'pull', '--ff-only');
    assert.equal(fs.existsSync(path.join(out, 'src/b.js')), true);
    assert.equal(
      fs.existsSync(path.join(out, 'src/a.js')),
      false,
      'a deleted file is deleted in the repository',
    );
    assert.equal(
      git(out, 'rev-list', '--count', 'HEAD'),
      '2',
      'history is kept, nothing is force-pushed',
    );
  } finally {
    await node.close();
    fx.cleanup();
  }
});

test('cloned themes (stored only in the database) are added under site/themes, and only when ticked', async () => {
  const fx = fixture();
  const node = await nodeFor(fx);
  try {
    await node.ctx.themes.duplicate('default', { newId: 'mine', name: 'Mine' }, null);
    const overview = await node.ctx.deploy.overview();
    assert.deepEqual(
      overview.available.themes.map((t) => t.id),
      ['mine'],
    );

    assert.equal((await deploy(node, { themes: [] })).status, 'done');
    let out = fx.clone();
    assert.equal(fs.existsSync(path.join(out, 'site/themes/mine')), false);

    const run = await deploy(node, { themes: ['mine', 'default', '../evil'] });
    assert.equal(run.status, 'done', run.message);
    assert.deepEqual(run.include.themes, ['mine'], 'built-in and invalid ids are ignored');
    git(out, 'pull', '--ff-only');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'site/themes/mine/theme.json'), 'utf8'),
    );
    assert.equal(manifest.id, 'mine');
  } finally {
    await node.close();
    fx.cleanup();
  }
});

test('failures are reported plainly and leave nothing behind: no target, an unreachable repository, a password in the URL', async () => {
  const fx = fixture();
  const node = await nodeFor(fx, { repo_url: '' });
  try {
    await assert.rejects(node.ctx.deploy.start({}, null), /Choose the deployment repository first/);

    await node.ctx.settings.update('deploy', {
      values: { repo_url: path.join(fx.root, 'nope.git') },
    });
    const run = await deploy(node);
    assert.equal(run.status, 'failed');
    assert.match(run.message, /Couldn't reach .*push access/);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), 'deploy')), false);
    assert.ok((await node.ctx.audit.list({ action: 'deploy.failed' })).length);

    await assert.rejects(
      node.ctx.settings.update('deploy', {
        values: { repo_url: 'https://user:token@example.com/r.git' },
      }),
      /Remove the password/,
    );
  } finally {
    await node.close();
    fx.cleanup();
  }
});

test('one deploy at a time; a run that died with its server stops blocking after an hour', async () => {
  const fx = fixture();
  const node = await nodeFor(fx);
  try {
    const first = await node.ctx.deploy.start({}, null);
    await assert.rejects(node.ctx.deploy.start({}, null), /already running/);
    await node.ctx.deploy.idle();
    await node.ctx.db('deploy_runs').insert({
      status: 'running',
      repo: 'x',
      branch: 'main',
      created_at: Date.now() - 2 * 3600_000,
    });
    const next = await node.ctx.deploy.start({}, null);
    await node.ctx.deploy.idle();
    assert.ok(next.id > first.id);
    const stale = await node.ctx.db('deploy_runs').where({ status: 'failed' });
    assert.ok(stale.some((r) => /stopped before it finished/.test(r.message)));
  } finally {
    await node.close();
    fx.cleanup();
  }
});

test('HTTP: reading needs deploy.read, saving the target and deploying need deploy.run, and a password in the URL is refused', async () => {
  const fx = fixture();
  const node = await nodeFor(fx);
  try {
    const viewer = await node.ctx.db('roles').where({ name: 'Viewer' }).first();
    await node.ctx.users.createUser(
      {
        email: 'v@example.com',
        name: 'V',
        password: 'Some-long-pass-12',
        roleId: Number(viewer.id),
      },
      null,
    );
    const reader = await node.ctx.users.createRole(
      { name: 'Reader', permissions: ['admin.access', 'deploy.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'r@example.com',
        name: 'R',
        password: 'Some-long-pass-12',
        roleId: Number(reader.id),
      },
      null,
    );
    const v = await signedIn(node.app, { email: 'v@example.com', password: 'Some-long-pass-12' });
    assert.equal((await v.get('/api/admin/deploy')).status, 403);
    const r = await signedIn(node.app, { email: 'r@example.com', password: 'Some-long-pass-12' });
    assert.equal((await r.get('/api/admin/deploy')).status, 200);
    assert.equal(
      (await r.put('/api/admin/deploy/target').send({ url: fx.origin, branch: 'main' })).status,
      403,
    );
    assert.equal((await r.post('/api/admin/deploy/run').send({})).status, 403);

    const a = await signedIn(node.app, ADMIN);
    const bad = await a
      .put('/api/admin/deploy/target')
      .send({ url: 'https://u:p@example.com/r.git', branch: 'main' });
    assert.equal(bad.status, 422);
    const ok = await a.put('/api/admin/deploy/target').send({ url: fx.origin, branch: 'release' });
    assert.equal(ok.status, 200);
    const started = await a.post('/api/admin/deploy/run').send({ siteTree: false });
    assert.equal(started.status, 202);
    await node.ctx.deploy.idle();
    const listed = (await a.get('/api/admin/deploy')).body;
    assert.equal(listed.runs[0].status, 'done');
    assert.equal(listed.runs[0].branch, 'release');
    assert.match(git(fx.root, 'ls-remote', '--heads', fx.origin), /refs\/heads\/release$/m);
  } finally {
    await node.close();
    fx.cleanup();
  }
});

test('end to end: a production checkout pulls the deploy with Updates, keeps its own data, and its rewritten site mirror does not block the update', async () => {
  const fx = fixture();
  const dev = await nodeFor(fx);
  let prod;
  try {
    await dev.ctx.siteFiles.put('pages/hello.html', '<h1>v1</h1>', null);
    assert.equal((await deploy(dev)).status, 'done');

    // Production: a checkout of the deployment repository with its own data folder, whose site mirror lives inside it.
    const server = fx.clone();
    git(server, 'checkout', '-B', 'main', 'origin/main');
    fs.mkdirSync(path.join(server, 'data/media'), { recursive: true });
    fs.writeFileSync(path.join(server, 'data/media/upload.jpg'), 'customer upload');
    fs.writeFileSync(path.join(server, '.env'), 'APP_MASTER_KEY=prod-secret');
    prod = await startNode({
      seed: true,
      appRoot: server,
      env: { SITE_DIR: path.join(server, 'public') },
    });
    await prod.ctx.settings.update('updates', {
      values: { source_url: fx.origin, source_branch: 'main', run_migrations: false },
    });
    await until(() => prod.ctx.updates.snapshot().git);

    // The app rewrites the mirror whenever the site is edited on production: a tracked file now differs from git.
    fs.writeFileSync(path.join(server, 'public/pages/hello.html'), '<h1>edited on production</h1>');
    assert.notEqual(git(server, 'status', '--porcelain', '--untracked-files=no'), '');

    await dev.ctx.siteFiles.put('pages/hello.html', '<h1>v2</h1>', null);
    fx.write('src/a.js', '// version 2');
    assert.equal((await deploy(dev)).status, 'done');

    await prod.ctx.updates.dispatch(prod.env.nodeId, 'apply', {}, null);
    await until(() => ['done', 'failed'].includes(prod.ctx.updates.snapshot().status), {
      timeout: 30000,
    });
    const snap = prod.ctx.updates.snapshot();
    assert.equal(snap.status, 'done', snap.message);
    assert.equal(fs.readFileSync(path.join(server, 'src/a.js'), 'utf8'), '// version 2');
    assert.equal(
      fs.readFileSync(path.join(server, 'public/pages/hello.html'), 'utf8'),
      '<h1>v2</h1>',
    );
    assert.equal(
      fs.readFileSync(path.join(server, 'data/media/upload.jpg'), 'utf8'),
      'customer upload',
    );
    assert.equal(fs.readFileSync(path.join(server, '.env'), 'utf8'), 'APP_MASTER_KEY=prod-secret');
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});

test('end to end: what dev built (pages, data, media, themes) arrives on production by pulling, and production keeps and never overwrites what it has', async () => {
  const fx = fixture();
  const dev = await nodeFor(fx);
  let prod;
  try {
    // Dev: two pages, a table of its own with two records, one uploaded file, a cloned theme.
    await dev.ctx.siteFiles.put('pages/hello.html', '<h1>dev hello</h1>', null);
    await dev.ctx.siteFiles.put('pages/about.html', '<h1>dev about</h1>', null);
    await dev.ctx.db.schema.createTable('data_notes', (t) => {
      t.integer('id').primary();
      t.string('title', 80);
    });
    await dev.ctx.db('data_notes').insert([
      { id: 1, title: 'from dev one' },
      { id: 2, title: 'from dev two' },
    ]);
    const file = await dev.ctx.media.upload({
      buffer: Buffer.from('hello media'),
      name: 'note.txt',
    });
    await dev.ctx.themes.duplicate('default', { newId: 'mine', name: 'Mine' }, null);

    const first = await deploy(dev, { themes: ['mine'] });
    assert.equal(first.status, 'done', first.message);
    assert.ok(
      first.include.data.tables >= 1 && first.include.data.media >= 1,
      JSON.stringify(first.include),
    );
    const out = fx.clone();
    assert.ok(fs.existsSync(path.join(out, 'deploy-data/manifest.json')));
    assert.ok(fs.existsSync(path.join(out, 'deploy-data/db/data_notes.ndjson')));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'deploy-data/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.secrets, 'remove', 'no secrets in the repository');
    assert.equal(manifest.createdAt, 0);

    // Production: its own checkout and database, with its own page, record and upload already.
    const server = fx.clone();
    git(server, 'checkout', '-B', 'main', 'origin/main');
    prod = await startNode({
      seed: true,
      appRoot: server,
      env: { SITE_DIR: path.join(server, 'public'), MEDIA_DIR: path.join(server, 'data/media') },
    });
    await prod.ctx.settings.update('updates', {
      values: { source_url: fx.origin, source_branch: 'main', run_migrations: false },
    });
    await until(() => prod.ctx.updates.snapshot().git);
    const actor = { id: 1, email: ADMIN.email };
    // The server was cloned AFTER the deploy, so it already has the code; the first Update imports nothing yet. Roll the
    // checkout back one commit to play a server that is behind (it had no deploy before).
    assert.equal(has(prod, 'pages/hello.html'), false);
    await prod.ctx.db.schema.createTable('data_notes', (t) => {
      t.integer('id').primary();
      t.string('title', 80);
    });
    await prod.ctx.db('data_notes').insert({ id: 2, title: 'prod owns record 2' });
    await prod.ctx.siteFiles.put('pages/prod-only.html', '<h1>only on prod</h1>', actor);

    // A second deploy from dev: one page changes, one record is new.
    await dev.ctx.siteFiles.put('pages/hello.html', '<h1>dev hello v2</h1>', null);
    await dev.ctx.db('data_notes').insert({ id: 3, title: 'new from dev' });
    const second = await deploy(dev, { themes: ['mine'] });
    assert.equal(second.status, 'done', second.message);

    // First pull: prod goes from the first deploy to the second.
    git(server, 'reset', '--hard', first.commit);
    await until(() => prod.ctx.updates.snapshot().git);
    await prod.ctx.updates.dispatch(prod.env.nodeId, 'apply', {}, actor);
    await until(() => ['done', 'failed'].includes(prod.ctx.updates.snapshot().status), {
      timeout: 60000,
    });
    const snap = prod.ctx.updates.snapshot();
    assert.equal(snap.status, 'done', snap.message);
    assert.match(snap.message, /imported 1 page file/);
    assert.match(snap.message, /added the data/);

    assert.match(
      String(prod.ctx.siteFiles.get('pages/hello.html')?.content),
      /dev hello v2/,
      'changed page arrives',
    );
    assert.equal(has(prod, 'pages/about.html'), false, 'unchanged pages are not touched');
    assert.match(String(prod.ctx.siteFiles.get('pages/prod-only.html')?.content), /only on prod/);
    const notes = await prod.ctx.db('data_notes').orderBy('id');
    assert.deepEqual(
      notes.map((n) => [n.id, n.title]),
      [
        [1, 'from dev one'],
        [2, 'prod owns record 2'],
        [3, 'new from dev'],
      ],
      'missing records are added; the record prod already had is kept as it is',
    );
    assert.ok(
      fs.existsSync(path.join(server, 'site/themes/mine/theme.json')),
      'the theme came with the code',
    );
    const media = await prod.ctx.db('media').where({ id: file.id }).first();
    assert.ok(media, 'the media record came across');
    assert.ok(
      await prod.ctx.storage.exists(`m/${media.id}/${media.original_file}`),
      'and so did its file',
    );
  } finally {
    await prod?.close();
    await dev.close();
    fx.cleanup();
  }
});
