import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, until, ADMIN } from './helpers.js';
import { scanMigration } from '../src/core/migration-guard.js';

const mig = (body, down = 'await knex.schema.dropTableIfExists("x");') =>
  `export async function up(knex) {\n${body}\n}\nexport async function down(knex) {\n${down}\n}\n`;

test('the scan names what up() removes or renames, and ignores down() and additive changes', () => {
  assert.deepEqual(scanMigration(mig("await knex.schema.createTable('x', () => {});")), []);
  assert.deepEqual(
    scanMigration(mig("await knex.schema.alterTable('entries', (t) => { t.string('seo'); });")),
    [],
  );
  assert.deepEqual(scanMigration(mig("await knex.schema.dropTable('entries');")), [
    'drops table entries',
  ]);
  assert.deepEqual(scanMigration(mig("await knex.schema.dropTableIfExists('old');")), [
    'drops table old',
  ]);
  assert.match(
    scanMigration(mig("await knex.schema.alterTable('e', (t) => { t.dropColumn('body'); });"))[0],
    /drops column body/,
  );
  assert.match(
    scanMigration(mig("await knex.schema.renameTable('a', 'b');"))[0],
    /renames table a to b/,
  );
  assert.match(
    scanMigration(
      mig("await knex.schema.alterTable('e', (t) => { t.renameColumn('a', 'b'); });"),
    )[0],
    /renames column a to b/,
  );
  assert.match(
    scanMigration(mig("await knex.raw('ALTER TABLE e DROP COLUMN body');"))[0],
    /DROP COLUMN body/,
  );
  assert.match(scanMigration(mig("await knex('entries').truncate();"))[0], /empties a table/);
  assert.match(scanMigration(mig("await knex.raw('DELETE FROM entries;');"))[0], /every row/);
  // A reviewed one says why and is let through.
  assert.deepEqual(
    scanMigration(
      '// destructive-ok: column was never used\n' + mig("await knex.schema.dropTable('x');"),
    ),
    [],
  );
});

test('every migration shipped in this repository only adds (a destructive one must say why with "destructive-ok")', () => {
  const dir = path.resolve(import.meta.dirname, '../migrations');
  const bad = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const found = scanMigration(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (found.length) bad[f] = found;
  }
  assert.deepEqual(bad, {});
});

// ── Updates refuses before anything changes ──
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

test('an update whose migration drops or renames data is refused untouched, warned about on check, and allowed only when switched on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mg-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const server = path.join(root, 'server');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, work);
  const push = (files, msg) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-m', msg);
    git(work, 'push', 'origin', 'HEAD:main');
  };
  push(
    {
      'package.json': '{"name":"f","version":"1.0.0","type":"module"}',
      'src/cli/index.js':
        "import fs from 'node:fs';\nfs.appendFileSync('migrate.log', 'ran\\n');\n",
      'app.txt': 'v1',
    },
    'one',
  );
  git(root, 'clone', origin, server);
  const node = await startNode({ seed: true, appRoot: server });
  try {
    await node.ctx.settings.update('updates', {
      values: { source_url: origin, source_branch: 'main' },
    });
    await until(() => node.ctx.updates.snapshot().git);
    const go = async (action) => {
      await node.ctx.updates.dispatch(node.env.nodeId, action, {}, { id: 1, email: ADMIN.email });
      await until(() => ['done', 'failed'].includes(node.ctx.updates.snapshot().status), {
        timeout: 30000,
      });
      return node.ctx.updates.snapshot();
    };
    push(
      {
        'app.txt': 'v2',
        'migrations/20270101000001_slim.js': mig(
          "await knex.schema.alterTable('entries', (t) => { t.dropColumn('data'); });",
        ),
      },
      'two',
    );
    const before = git(server, 'rev-parse', 'HEAD');

    const checked = await go('check');
    assert.match(
      checked.message,
      /1 update available\. Warning: .*20270101000001_slim\.js \(drops column data\)/,
    );

    const refused = await go('apply');
    assert.equal(refused.status, 'failed');
    assert.match(
      refused.message,
      /removes or renames data: 20270101000001_slim\.js \(drops column data\)\. Nothing was changed/,
    );
    assert.match(refused.message, /Take a backup/);
    assert.equal(git(server, 'rev-parse', 'HEAD'), before, 'the code was not touched');
    assert.equal(fs.readFileSync(path.join(server, 'app.txt'), 'utf8'), 'v1');
    assert.ok(!fs.existsSync(path.join(server, 'migrate.log')), 'no migration ran');

    await node.ctx.settings.update('updates', { values: { allow_destructive_migrations: true } });
    const allowed = await go('apply');
    assert.equal(allowed.status, 'done', allowed.message);
    assert.equal(fs.readFileSync(path.join(server, 'app.txt'), 'utf8'), 'v2');
  } finally {
    await node.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
